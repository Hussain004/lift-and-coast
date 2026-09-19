/**
 * Build-time track processor (plan section 4).
 *
 * Reads a raw circuit polyline (lon/lat) from data/tracks/raw, projects it
 * to a local meter-based plane, fits a centripetal Catmull-Rom spline
 * through it, and resamples at a fixed arc-length interval so the runtime
 * mesh/collider/AI code always works with uniform spacing.
 *
 * Run with: node --experimental-strip-types scripts/build-track.mts
 *
 * Width is real: it comes from the vendored TUMFTM racetrack-database
 * (per-point widths aligned onto this centerline - see the README next to
 * those files). Elevation is real too: it comes from vendored DEM samples of
 * each circuit's own coordinates (see scripts/fetch-elevation.mts), averaged
 * in the projected plane and normalized so the start/finish line sits at y=0.
 * The profile is therefore real but coarse - a 90m DEM reports the terrain
 * around the circuit, not the asphalt's own grade, so it is averaged over a
 * wide disc and should be read as the broad shape of the lap, not a surveyed
 * surface (and it cannot resolve a bridge, so a self-crossing reads as a flat
 * junction). Camber, kerbs, surface zones and the racing line are still
 * per-corner authoring work (plan section 4) and are deliberately not
 * computed here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Point {
  x: number;
  z: number;
}

interface TrackJson {
  id: string;
  name: string;
  lengthMeters: number;
  centerline: [number, number, number][];
  width: number[];
  startPos: { x: number; z: number; headingRad: number };
}

const RESAMPLE_SPACING_METERS = 2;
// Fallback width for a circuit with no vendored TUMFTM width file.
const DEFAULT_WIDTH_METERS = 13;
const MIN_POINT_SEPARATION_METERS = 1;
// Half-window, in centerline points, of the wrap-around moving average
// applied to the transferred widths. The transfer is nearest-neighbour, so
// its raw output is piecewise-constant with small steps where the nearest
// index switches; +/-4 points (+/-8 m at the 2 m spacing) smooths those
// without blunting real corner-to-corner width changes.
const WIDTH_SMOOTH_HALF_WINDOW = 4;
// Elevation averaging radius, in meters, in the projected plane. The DEM is
// ~90m per sample and reports the hillside next to the track as often as the
// track itself - raw samples produce grades of 50-84% (Spa), which no real
// circuit has - so the average has to be wide. It also has to be wide for a
// second reason: consecutive DEM cells step by up to 30m where they straddle
// a cliff (Spa's profile jumps 400m -> 439m between samples 25m apart), and
// only a disc several cells across spreads a step like that out into a
// credible grade. With this value the built profiles read Silverstone 11m of
// relief at a 2% peak grade, Monza 20m/4%, Suzuka 45m/6% and Spa 92m/11%,
// which is the right ballpark for the real circuits (see
// tests/trackRegistry.test.ts).
const ELEVATION_FIELD_RADIUS_METERS = 300;
// ICP correspondence search is O(theirs x ours) per iteration. Subsampling
// both by this stride keeps the build fast; verified to converge to the same
// residual as the full-resolution fit.
const ICP_ITERATIONS = 80;
const ICP_STRIDE = 4;

function lonLatToMeters(
  coords: [number, number][],
  centerLon: number,
  centerLat: number
): Point[] {
  const centerLatRad = (centerLat * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos(centerLatRad);
  return coords.map(([lon, lat]) => ({
    x: (lon - centerLon) * metersPerDegLon,
    z: -(lat - centerLat) * metersPerDegLat,
  }));
}

function dedupeClose(points: Point[], minDist: number): Point[] {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = out[out.length - 1];
    const d = Math.hypot(points[i].x - prev.x, points[i].z - prev.z);
    if (d >= minDist) out.push(points[i]);
  }
  // Drop a trailing point that nearly coincides with the start (closed loop).
  const first = out[0];
  const last = out[out.length - 1];
  if (Math.hypot(last.x - first.x, last.z - first.z) < minDist) out.pop();
  return out;
}

/** Centripetal Catmull-Rom through a closed loop of control points. */
function catmullRomClosed(points: Point[], samplesPerSegment: number): Point[] {
  const n = points.length;
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z) ** 0.5;
  const result: Point[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);

    for (let s = 0; s < samplesPerSegment; s++) {
      const t = t1 + ((t2 - t1) * s) / samplesPerSegment;
      const lerp = (a: Point, b: Point, ta: number, tb: number): Point => ({
        x: ((tb - t) / (tb - ta)) * a.x + ((t - ta) / (tb - ta)) * b.x,
        z: ((tb - t) / (tb - ta)) * a.z + ((t - ta) / (tb - ta)) * b.z,
      });
      const a1 = lerp(p0, p1, t0, t1);
      const a2 = lerp(p1, p2, t1, t2);
      const a3 = lerp(p2, p3, t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      result.push(lerp(b1, b2, t1, t2));
    }
  }
  return result;
}

/** Resample a closed polyline at fixed arc-length spacing. */
function resampleByArcLength(points: Point[], spacing: number): Point[] {
  const cumulative: number[] = [0];
  for (let i = 1; i <= points.length; i++) {
    const a = points[i - 1];
    const b = points[i % points.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
  }
  const totalLength = cumulative[cumulative.length - 1];
  const out: Point[] = [];
  let segment = 0;
  for (let d = 0; d < totalLength; d += spacing) {
    while (cumulative[segment + 1] < d) segment++;
    const segStart = cumulative[segment];
    const segEnd = cumulative[segment + 1];
    const a = points[segment % points.length];
    const b = points[(segment + 1) % points.length];
    const u = segEnd === segStart ? 0 : (d - segStart) / (segEnd - segStart);
    out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
  }
  return out;
}

interface WidthSource {
  /** File centerline, mirrored onto the project's axis convention (z = -y). */
  points: Point[];
  /** Total track width (right + left) at each point, in meters. */
  totalWidth: number[];
}

/**
 * Reads a TUMFTM racetrack-database CSV (`x_m,y_m,w_tr_right_m,w_tr_left_m`).
 * The `y` axis is negated because this project's lon/lat projection maps
 * latitude to `-z` while the file's frame maps it to `+y`, leaving the two
 * shapes mirror images. Verified: without the mirror the best rigid-fit RMS
 * is 100-170 m; with it, 1.2-1.8 m on all four circuits.
 */
function loadWidthSource(path: string): WidthSource {
  const rows = readFileSync(path, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .map((line) => line.split(",").map(Number));
  return {
    points: rows.map((r) => ({ x: r[0], z: -r[1] })),
    totalWidth: rows.map((r) => r[2] + r[3]),
  };
}

interface RigidTransform {
  theta: number;
  tx: number;
  tz: number;
}

function applyRigid(p: Point, t: RigidTransform): Point {
  const c = Math.cos(t.theta);
  const s = Math.sin(t.theta);
  return { x: p.x * c - p.z * s + t.tx, z: p.x * s + p.z * c + t.tz };
}

function nearestSquareDistance(a: Point, b: Point[]): number {
  let best = Infinity;
  for (const p of b) {
    const d = (a.x - p.x) ** 2 + (a.z - p.z) ** 2;
    if (d < best) best = d;
  }
  return best;
}

function meanPoint(pts: Point[]): Point {
  let x = 0;
  let z = 0;
  for (const p of pts) {
    x += p.x;
    z += p.z;
  }
  return { x: x / pts.length, z: z / pts.length };
}

/**
 * Iterative closest point - rotation + translation only, seeded from the
 * centroid difference. Deterministic (fixed seed, fixed iteration order).
 * Both datasets trace the same circuit, so a rigid fit is the right model;
 * the residual is the two smoothing passes' own difference, not a real
 * geometry mismatch.
 */
function fitRigidTo(
  ours: Point[],
  theirs: Point[]
): { transform: RigidTransform; rms: number } {
  const a = theirs.filter((_, i) => i % ICP_STRIDE === 0);
  const b = ours;
  const ca = meanPoint(a);
  const cb = meanPoint(b);
  let t: RigidTransform = { theta: 0, tx: cb.x - ca.x, tz: cb.z - ca.z };
  let rms = Infinity;

  for (let iter = 0; iter < ICP_ITERATIONS; iter++) {
    const pairsA: Point[] = [];
    const pairsB: Point[] = [];
    for (const p of a) {
      const q = applyRigid(p, t);
      let best = Infinity;
      let bestIdx = 0;
      for (let j = 0; j < b.length; j++) {
        const d = (q.x - b[j].x) ** 2 + (q.z - b[j].z) ** 2;
        if (d < best) {
          best = d;
          bestIdx = j;
        }
      }
      pairsA.push(p);
      pairsB.push(b[bestIdx]);
    }
    const ma = meanPoint(pairsA);
    const mb = meanPoint(pairsB);
    let num = 0;
    let den = 0;
    for (let i = 0; i < pairsA.length; i++) {
      const ax = pairsA[i].x - ma.x;
      const az = pairsA[i].z - ma.z;
      const bx = pairsB[i].x - mb.x;
      const bz = pairsB[i].z - mb.z;
      num += ax * bz - az * bx;
      den += ax * bx + az * bz;
    }
    const theta = Math.atan2(num, den);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    t = {
      theta,
      tx: mb.x - (ma.x * c - ma.z * s),
      tz: mb.z - (ma.x * s + ma.z * c),
    };

    let sum = 0;
    for (const p of a) sum += nearestSquareDistance(applyRigid(p, t), b);
    const next = Math.sqrt(sum / a.length);
    if (Math.abs(rms - next) < 1e-4) {
      rms = next;
      break;
    }
    rms = next;
  }
  return { transform: t, rms };
}

/**
 * For each built centerline point, the total width of the nearest source
 * point after alignment. Nearest-neighbour (rather than an arc-length
 * lookup) means a different start line or index origin between the two
 * datasets cannot shift the profile; the fit residual above bounds the
 * geometric error this picks up.
 */
function transferWidths(
  ours: Point[],
  source: WidthSource,
  t: RigidTransform
): number[] {
  const theirs = source.points.map((p) => applyRigid(p, t));
  return ours.map((p) => {
    let best = Infinity;
    let bestIdx = 0;
    for (let j = 0; j < theirs.length; j++) {
      const d = (p.x - theirs[j].x) ** 2 + (p.z - theirs[j].z) ** 2;
      if (d < best) {
        best = d;
        bestIdx = j;
      }
    }
    return source.totalWidth[bestIdx];
  });
}

function smoothWrap(values: number[], halfWindow: number): number[] {
  const n = values.length;
  return values.map((_, i) => {
    let sum = 0;
    for (let k = -halfWindow; k <= halfWindow; k++) {
      sum += values[(i + k + n) % n];
    }
    return sum / (halfWindow * 2 + 1);
  });
}

interface ElevationSource {
  /** The same projected raw polyline the centerline was splined through. */
  points: Point[];
  /** One elevation per point, in meters. */
  elevation: number[];
}

/**
 * Reads the vendored DEM samples fetched by scripts/fetch-elevation.mts:
 * lon/lat pairs walked along the lap at a fixed spacing, one elevation each.
 * They are projected here with the same `lonLatToMeters` (and the same
 * circuit centre) as the centerline, so both live in one frame.
 */
function loadElevationSource(
  path: string,
  centerLon: number,
  centerLat: number
): ElevationSource {
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const coordinates: [number, number][] = raw.coordinates;
  const elevation: number[] = raw.elevationMeters;
  if (!Array.isArray(elevation) || elevation.length !== coordinates.length) {
    throw new Error(
      `${path}: expected one elevation per coordinate, got ${elevation?.length} for ${coordinates?.length}`
    );
  }
  return { points: lonLatToMeters(coordinates, centerLon, centerLat), elevation };
}

/**
 * Ground elevation at each built centerline point: the distance-weighted mean
 * of every vendored DEM sample within ELEVATION_FIELD_RADIUS_METERS of the
 * point *in the projected plane*.
 *
 * Weighting in 2D rather than along the track is what makes a self-crossing
 * consistent. Suzuka is a figure-8 whose two arms pass within ~1m of each
 * other in plan while sitting ~5m apart in height, and a 90m DEM cannot see
 * the bridge that separates them: it reports one ground elevation for both.
 * Smoothing along the track gives the arms different answers anyway (their
 * approaches run over different hillsides), which forces the terrain into a
 * choice it cannot make - see lib/tracks/terrain.ts. A 2D neighbourhood is
 * the same neighbourhood for both arms, so their profiles agree wherever
 * they touch, and the crossing comes out as the flat junction the data
 * actually describes.
 *
 * A weighted mean passes slopes through unchanged and only rounds off
 * curvature, so the wide radius costs profile detail rather than gradient.
 */
function averageElevations(ours: Point[], source: ElevationSource): number[] {
  const radius = ELEVATION_FIELD_RADIUS_METERS;
  const radiusSq = radius * radius;
  return ours.map((p) => {
    let sum = 0;
    let weight = 0;
    let nearestSq = Infinity;
    let nearestElevation = 0;
    for (let i = 0; i < source.points.length; i++) {
      const dx = p.x - source.points[i].x;
      const dz = p.z - source.points[i].z;
      const distSq = dx * dx + dz * dz;
      if (distSq < nearestSq) {
        nearestSq = distSq;
        nearestElevation = source.elevation[i];
      }
      if (distSq >= radiusSq) continue;
      const w = (1 - Math.sqrt(distSq) / radius) ** 2;
      sum += source.elevation[i] * w;
      weight += w;
    }
    return weight > 0 ? sum / weight : nearestElevation;
  });
}

/**
 * Locates the real start/finish line on a raw loop via the TUMFTM
 * centerline: TUMFTM laps start at s=0 on the line, so the rigid-aligned
 * first CSV row sits on the raw loop where the line is. Returns RAW arc
 * meters (the unit startAtMeters takes), resolved through the nearest raw
 * vertex to the spline position, so the cut lands exactly on a vertex.
 * Same fit the width transfer uses (order-independent), so the station is
 * consistent with the aligned widths by construction.
 */
export function locateTumftmStart(rawPath: string, widthPath: string): number {
  const raw = JSON.parse(readFileSync(rawPath, "utf-8"));
  const rawCoords: [number, number][] = raw.features[0].geometry.coordinates;
  const lons = rawCoords.map((c) => c[0]);
  const lats = rawCoords.map((c) => c[1]);
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const projected = lonLatToMeters(rawCoords, centerLon, centerLat);
  const controlPoints = dedupeClose(projected, MIN_POINT_SEPARATION_METERS);
  const fine = catmullRomClosed(controlPoints, 20);
  const resampled = resampleByArcLength(fine, RESAMPLE_SPACING_METERS);
  const source = loadWidthSource(widthPath);
  const { transform, rms } = fitRigidTo(resampled, source.points);
  const s0 = applyRigid(source.points[0], transform);
  let bestIdx = 0;
  let best = Infinity;
  for (let i = 0; i < resampled.length; i++) {
    const d = (resampled[i].x - s0.x) ** 2 + (resampled[i].z - s0.z) ** 2;
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  // Back to the nearest raw vertex: startAtMeters cuts there.
  let bestRaw = 0;
  let bestRawD = Infinity;
  for (let i = 0; i < projected.length; i++) {
    const d =
      (projected[i].x - resampled[bestIdx].x) ** 2 +
      (projected[i].z - resampled[bestIdx].z) ** 2;
    if (d < bestRawD) {
      bestRawD = d;
      bestRaw = i;
    }
  }
  const meanLat = rawCoords.reduce((s, c) => s + c[1], 0) / rawCoords.length;
  const mLon = 111320 * Math.cos((meanLat * Math.PI) / 180);
  const segLen = (a: [number, number], b: [number, number]) =>
    Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * 111320);
  let arc = 0;
  for (let i = 0; i < bestRaw; i++) {
    arc += segLen(rawCoords[i], rawCoords[(i + 1) % rawCoords.length]);
  }
  console.log(
    `  tumftm s=0 lands ~${arc.toFixed(0)}m along the raw loop (fit rms ${rms.toFixed(2)}m)`
  );
  return arc;
}

function buildTrack(
  rawPath: string,
  id: string,
  name: string,
  widthPath?: string,
  elevationPath?: string,
  // Hand-authored width segments ([fromMeters, toMeters, width]) in lap
  // stations from the start line, for circuits the TUMFTM database does not
  // cover (Monaco). Piecewise-constant here; the shared smoother below
  // rounds the transitions. Must cover the whole lap - a gap throws, so a
  // mis-authored table fails the build instead of shipping a 13m default
  // somewhere. An approximation of the real street widths (7m at the
  // hairpin, ~12m on the straights), documented as such: replace with
  // measured data if a source ever exists.
  manualWidths?: [number, number, number][],
  // Hand-authored elevation keyframes ([stationMeters, y]) for circuits
  // where the DEM cannot supply even the broad shape: Monaco is a dense
  // street circuit on a steep hill above the sea, and the 90m DSM reports
  // rooftops while the 300m averaging disc mixes hillside with open water,
  // which baked an inverted profile (start highest, port 42m below it).
  // Cosine-interpolated cyclically, so any keyframe set closes smoothly.
  // Shape and relief (~35m climb to Casino) follow the real circuit;
  // magnitudes are ballpark, documented as such.
  manualElevation?: [number, number][],
  manualElevationBlendRadiusMeters?: number,
  // Raw arc distance (meters along the source polyline from its first
  // vertex) to rotate the loop so index 0 lands on, for datasets whose
  // first vertex is mid-lap rather than on the start/finish straight
  // (Monaco's starts on the Beau Rivage climb). Rotation preserves order
  // and direction; only the lap line, grid and station-indexed tables move.
  // The DEM averaging and TUMFTM alignment are index-agnostic, unaffected.
  startAtMeters?: number,
): TrackJson {
  const raw = JSON.parse(readFileSync(rawPath, "utf-8"));
  const feature = raw.features[0];
  let rawCoords: [number, number][] = feature.geometry.coordinates;
  if (startAtMeters !== undefined) {
    // Walk to the target arc distance, then rotate so that vertex is first.
    // Distances in meters via the same equirectangular projection the build
    // uses below (raw degrees would silently misplace the cut).
    const meanLat =
      rawCoords.reduce((s, c) => s + c[1], 0) / rawCoords.length;
    const mLon = 111320 * Math.cos((meanLat * Math.PI) / 180);
    const segLen = (a: [number, number], b: [number, number]) =>
      Math.hypot((b[0] - a[0]) * mLon, (b[1] - a[1]) * 111320);
    let total = 0;
    for (let i = 0; i < rawCoords.length; i++) {
      total += segLen(rawCoords[i], rawCoords[(i + 1) % rawCoords.length]);
    }
    let acc = 0;
    let cut = 0;
    let best = Infinity;
    const target = ((startAtMeters % total) + total) % total;
    for (let i = 0; i < rawCoords.length; i++) {
      const dist = Math.abs(acc - target);
      if (dist < best) {
        best = dist;
        cut = i;
      }
      acc += segLen(rawCoords[i], rawCoords[(i + 1) % rawCoords.length]);
    }
    rawCoords = [...rawCoords.slice(cut), ...rawCoords.slice(0, cut)];
    console.log(`  rotated loop to raw vertex ${cut} (~${startAtMeters}m) for the start line`);
  }

  const lons = rawCoords.map((c) => c[0]);
  const lats = rawCoords.map((c) => c[1]);
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;

  const projected = lonLatToMeters(rawCoords, centerLon, centerLat);
  const controlPoints = dedupeClose(projected, MIN_POINT_SEPARATION_METERS);
  const fine = catmullRomClosed(controlPoints, 20);
  const resampled = resampleByArcLength(fine, RESAMPLE_SPACING_METERS);

  let elevation: number[] = resampled.map(() => 0);
  if (manualElevation) {
    const keys = [...manualElevation].sort((a, b) => a[0] - b[0]);
    let total = 0;
    for (let i = 0; i < resampled.length; i++) {
      const a = resampled[i];
      const b = resampled[(i + 1) % resampled.length];
      total += Math.hypot(b.x - a.x, b.z - a.z);
    }
    const at = (d: number): number => {
      const dd = ((d % total) + total) % total;
      let i = keys.length - 1;
      while (!(keys[i][0] <= dd || i === 0)) i--;
      const a = keys[i];
      const b = keys[(i + 1) % keys.length];
      const bStation = b[0] <= a[0] ? b[0] + total : b[0];
      const u = bStation === a[0] ? 0 : (dd < a[0] ? dd + total - a[0] : dd - a[0]) / (bStation - a[0]);
      const s = (1 - Math.cos(u * Math.PI)) / 2;
      return a[1] + (b[1] - a[1]) * s;
    };
    // Stations are index*spacing throughout the runtime (startPos,
    // sectors, AI), so keyframes use that convention, not chord length.
    elevation = resampled.map((_, i) => at(i * RESAMPLE_SPACING_METERS));
    if (manualElevationBlendRadiusMeters) {
      // The keyframes are station-indexed (1D): where two arms of the lap
      // pass close in plan at genuinely different heights - the hairpin,
      // the port - they disagree, and the nearest-point terrain between
      // them tilts into a wall through the lower arm (the failure
      // lib/tracks/terrain.ts documents). Blend in the projected plane
      // with the same kernel averageElevations uses for DEM samples, so
      // overlapping arms agree the way Suzuka's crossing does. Re-anchor
      // the start line afterwards, since blending moves it.
      const R = manualElevationBlendRadiusMeters;
      const src = elevation;
      elevation = resampled.map((p) => {
        let sum = 0;
        let wsum = 0;
        for (let j = 0; j < resampled.length; j++) {
          const q = resampled[j];
          const d = Math.hypot(p.x - q.x, p.z - q.z);
          if (d >= R) continue;
          const w = (1 - d / R) ** 2;
          sum += src[j] * w;
          wsum += w;
        }
        return sum / wsum;
      });
      const b0 = elevation[0];
      elevation = elevation.map((e) => e - b0);
    }
    const min = Math.min(...elevation);
    const max = Math.max(...elevation);
    console.log(
      `  elevation: hand-authored keyframes, ${min.toFixed(1)} to ${max.toFixed(1)}m (start at 0)`
    );
  } else if (elevationPath) {
    const source = loadElevationSource(elevationPath, centerLon, centerLat);
    const field = averageElevations(resampled, source);
    // Normalize the start/finish line to y=0 so spawning, resetting and the
    // camera all keep working off a track-relative floor unchanged - the
    // runtime only ever needs the profile's shape, and the DEM's own datum
    // (which disagrees with the dataset's `altitude` property by tens of
    // meters) is meaningless for physics.
    const offset = field[0];
    elevation = field.map((e) => e - offset);
    const min = Math.min(...elevation);
    const max = Math.max(...elevation);
    console.log(
      `  elevation: ${elevationPath.split("/").pop()} baked, ${min.toFixed(
        1
      )} to ${max.toFixed(1)}m (start at 0)`
    );
  }

  const centerline: [number, number, number][] = resampled.map((p, i) => [
    p.x,
    elevation[i],
    p.z,
  ]);

  let width: number[];
  if (widthPath) {
    const source = loadWidthSource(widthPath);
    const { transform, rms } = fitRigidTo(resampled, source.points);
    width = smoothWrap(
      transferWidths(resampled, source, transform),
      WIDTH_SMOOTH_HALF_WINDOW
    );
    const min = Math.min(...width);
    const max = Math.max(...width);
    console.log(
      `  width: ${widthPath.split("/").pop()} aligned (rms ${rms.toFixed(
        2
      )}m), ${min.toFixed(1)}-${max.toFixed(1)}m`
    );
  } else if (manualWidths) {
    const raw = resampled.map((_, i) => {
      const d = i * RESAMPLE_SPACING_METERS;
      const seg = manualWidths.find(([from, to]) => d >= from && d < to);
      if (!seg) {
        throw new Error(`${id}: no manual width covers lap station ${d}m`);
      }
      return seg[2];
    });
    width = smoothWrap(raw, WIDTH_SMOOTH_HALF_WINDOW);
    const min = Math.min(...width);
    const max = Math.max(...width);
    console.log(
      `  width: hand-authored segments (TUMFTM has no coverage), ${min.toFixed(1)}-${max.toFixed(1)}m`
    );
  } else {
    width = resampled.map(() => DEFAULT_WIDTH_METERS);
    console.log(`  width: no source file, flat ${DEFAULT_WIDTH_METERS}m`);
  }

  const start = resampled[0];
  const next = resampled[1];
  const tangentX = next.x - start.x;
  const tangentZ = next.z - start.z;
  const tangentLen = Math.hypot(tangentX, tangentZ);
  const headingRad = Math.atan2(-tangentX / tangentLen, -tangentZ / tangentLen);

  let lengthMeters = 0;
  for (let i = 0; i < resampled.length; i++) {
    const a = resampled[i];
    const b = resampled[(i + 1) % resampled.length];
    lengthMeters += Math.hypot(b.x - a.x, b.z - a.z);
  }

  return {
    id,
    name,
    lengthMeters: Math.round(lengthMeters),
    centerline,
    width,
    startPos: { x: start.x, z: start.z, headingRad },
  };
}

const scriptDir = fileURLToPath(new URL(".", import.meta.url));

// Plan section 4 / Phase 4 (content scale-out): one raw GeoJSON per circuit
// from the bacinger/f1-circuits dataset (MIT), built through the same
// project-resample-spline pipeline. The dataset's `length` property is the
// real-circuit reference length, printed below as a sanity check; the built
// lengthMeters from resampling lands within a percent or two (the source
// polyline already approximates the real geometry). `widthFile` names the
// vendored TUMFTM racetrack-database CSV that supplies the real per-point
// track width for that circuit, and `elevationFile` the vendored DEM samples
// (both null when a dataset has no coverage for a circuit - the build then
// falls back to a flat 13m ribbon at y=0, unless `manualWidths` carries a
// hand-authored width profile, as it does for Monaco which TUMFTM skips).
const TRACKS: {
  rawPath: string;
  id: string;
  name: string;
  widthFile: string | null;
  elevationFile: string | null;
  manualWidths?: [number, number, number][];
  manualElevation?: [number, number][];
  manualElevationBlendRadiusMeters?: number;
  startAtMeters?: number;
  // Derive the start line from the TUMFTM centerline (its laps start at
  // s=0 on the line) instead of hand-placing it. Only for tracks whose
  // raw index 0 is not already on the start straight - the shipped five
  // keep their explicit values (or natural zero), so their built bytes
  // never move for a pipeline change.
  autoStart?: boolean;
}[] = [
  {
    rawPath: `${scriptDir}/../data/tracks/raw/gb-1948.geojson`,
    id: "silverstone",
    name: "Silverstone Circuit",
    widthFile: "Silverstone.csv",
    elevationFile: "silverstone.json",
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/be-1925.geojson`,
    id: "spa",
    name: "Circuit de Spa-Francorchamps",
    widthFile: "Spa.csv",
    elevationFile: "spa.json",
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/it-1922.geojson`,
    id: "monza",
    name: "Autodromo Nazionale Monza",
    widthFile: "Monza.csv",
    elevationFile: "monza.json",
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/jp-1962.geojson`,
    id: "suzuka",
    name: "Suzuka International Racing Course",
    widthFile: "Suzuka.csv",
    elevationFile: "suzuka.json",
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/at-1969.geojson`,
    id: "spielberg",
    name: "Red Bull Ring",
    widthFile: "Spielberg.csv",
    elevationFile: "spielberg.json",
    autoStart: true,
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/bh-2002.geojson`,
    id: "bahrain",
    name: "Bahrain International Circuit",
    widthFile: "Sakhir.csv",
    elevationFile: "bahrain.json",
    autoStart: true,
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/us-2012.geojson`,
    id: "cota",
    name: "Circuit of the Americas",
    widthFile: "Austin.csv",
    elevationFile: "cota.json",
    autoStart: true,
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/nl-1948.geojson`,
    id: "zandvoort",
    name: "Circuit Zandvoort",
    widthFile: "Zandvoort.csv",
    elevationFile: "zandvoort.json",
    autoStart: true,
  },
  {
    rawPath: `${scriptDir}/../data/tracks/raw/mc-1929.geojson`,
    id: "monaco",
    name: "Circuit de Monaco",
    widthFile: null,
    elevationFile: null,
    // Stations from the start line (natural zero sits mid pit-straight -
    // verified against the corner sequence, see the Monaco commit). Real
    // street widths are ~7m at the hairpin and ~12m on the fast sections.
    manualWidths: [
      [0, 350, 12],
      [350, 550, 10],
      [550, 800, 9],
      [800, 1000, 10],
      [1000, 1200, 9],
      [1200, 1420, 7],
      [1420, 1600, 9],
      [1600, 2200, 11],
      [2200, 2400, 9],
      [2400, 2560, 10],
      [2560, 2860, 9],
      [2860, 3150, 9],
      [3150, 3340, 12],
    ],
    // The dataset starts mid-lap on the Beau Rivage climb; rotate so index
    // 0 (lap line, grid) sits mid pit-straight (corner-sequence verified).
    startAtMeters: 2378,
    // Climb to Casino, down to the port, flat along the water, gentle rise
    // back to the line. Relief ~32m, steepest ~11% (the Beau Rivage climb
    // and the Mirabeau descent). The descent is shaped so the hairpin's two
    // arms agree: their fold stacks within ~20m in plan, and the terrain
    // field is nearest-point, so if the entry arm (st ~1212-1240, arriving
    // from Mirabeau) sat much above the exit arm (st ~1390-1450, climbing to
    // Portier) the ground between them would rise through the lower ribbon.
    // The keyframes therefore land both arms low and level near the hairpin
    // (the same problem build-track's DEM averaging solves at Suzuka, handled
    // here by 2D-blending the keyframes - see manualElevationBlendRadiusMeters).
    manualElevation: [
      [0, 0],
      [450, 2],
      [800, 27],
      [900, 32],
      [1020, 24],
      [1150, 15],
      [1240, 12],
      [1300, 12],
      [1370, 12],
      [1450, 10],
      [1500, 7.5],
      [1700, 2],
      [2200, 2],
      [2320, 0],
      [2470, 0],
      [2780, 0],
      [3000, 3],
      [3150, 4],
    ],
    // 2D-blend the keyframes so overlapping arms (hairpin, port) agree the
    // way the DEM pipeline's own averaging makes Suzuka's crossing agree.
    manualElevationBlendRadiusMeters: 40,
  },
];

let totalPoints = 0;
// Menu-safe outline per circuit (plan section 8: track preview): the race
// route's per-track JSON is ~550KB of centerline the menu bundle must never
// pull in (see lib/tracks/registry.ts), so the build also emits this tiny
// sidecar - a stride-sampled top-down outline plus the facts the preview
// prints. x/z are the projected meters themselves, so the preview draws
// them with the minimap's own convention (X -> path X, Z -> path Y, no
// flip), which is north-up because the projection is z-south-positive.
// Direction of travel as seen on that north-up drawing: positive signed
// area in y-down screen coords runs clockwise.
const OUTLINE_POINTS = 120;
const outlines: {
  id: string;
  lengthMeters: number;
  direction: "clockwise" | "counterclockwise";
  points: [number, number][];
}[] = [];
for (const { rawPath, id, name, widthFile, elevationFile, manualWidths, manualElevation, manualElevationBlendRadiusMeters, startAtMeters, autoStart } of TRACKS) {
  const raw = JSON.parse(readFileSync(rawPath, "utf-8"));
  const referenceLength = raw.features[0].properties.length;
  const widthPath = widthFile
    ? `${scriptDir}/../data/tracks/raw/tumftm/${widthFile}`
    : undefined;
  const elevationPath = elevationFile
    ? `${scriptDir}/../data/tracks/raw/elevation/${elevationFile}`
    : undefined;
  const resolvedStart =
    startAtMeters ?? (autoStart && widthPath ? locateTumftmStart(rawPath, widthPath) : undefined);
  const track = buildTrack(rawPath, id, name, widthPath, elevationPath, manualWidths, manualElevation, manualElevationBlendRadiusMeters, resolvedStart);
  writeFileSync(
    `${scriptDir}/../data/tracks/${id}.json`,
    JSON.stringify(track)
  );
  const stride = Math.max(1, Math.floor(track.centerline.length / OUTLINE_POINTS));
  const points = track.centerline
    .filter((_, i) => i % stride === 0)
    .map(([x, , z]): [number, number] => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[(i + 1) % points.length];
    area += x0 * z1 - x1 * z0;
  }
  outlines.push({
    id,
    lengthMeters: track.lengthMeters,
    direction: area >= 0 ? "clockwise" : "counterclockwise",
    points,
  });
  totalPoints += track.centerline.length;
  console.log(
    `Built ${track.name}: ${track.centerline.length} points, ${track.lengthMeters}m (reference: ${referenceLength}m)`
  );
}
writeFileSync(`${scriptDir}/../data/tracks/outlines.json`, JSON.stringify(outlines));
console.log(`Total centerline points across ${TRACKS.length} tracks: ${totalPoints}`);
