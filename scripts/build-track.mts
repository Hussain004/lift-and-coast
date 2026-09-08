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
 * Elevation, camber, kerbs, surface zones, and the racing line are real
 * per-corner authoring work (plan section 4) and are deliberately not
 * computed here - centerline is flat (y=0) and width is a placeholder
 * constant until that authoring happens.
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
const DEFAULT_WIDTH_METERS = 13;
const MIN_POINT_SEPARATION_METERS = 1;

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

function buildTrack(rawPath: string, id: string, name: string): TrackJson {
  const raw = JSON.parse(readFileSync(rawPath, "utf-8"));
  const feature = raw.features[0];
  const rawCoords: [number, number][] = feature.geometry.coordinates;

  const lons = rawCoords.map((c) => c[0]);
  const lats = rawCoords.map((c) => c[1]);
  const centerLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  const centerLat = (Math.min(...lats) + Math.max(...lats)) / 2;

  const projected = lonLatToMeters(rawCoords, centerLon, centerLat);
  const controlPoints = dedupeClose(projected, MIN_POINT_SEPARATION_METERS);
  const fine = catmullRomClosed(controlPoints, 20);
  const resampled = resampleByArcLength(fine, RESAMPLE_SPACING_METERS);

  const centerline: [number, number, number][] = resampled.map((p) => [
    p.x,
    0,
    p.z,
  ]);
  const width = resampled.map(() => DEFAULT_WIDTH_METERS);

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
const track = buildTrack(
  `${scriptDir}/../data/tracks/raw/gb-1948.geojson`,
  "silverstone",
  "Silverstone Circuit"
);

writeFileSync(
  `${scriptDir}/../data/tracks/silverstone.json`,
  JSON.stringify(track)
);

console.log(
  `Built ${track.name}: ${track.centerline.length} points, ${track.lengthMeters}m (reference: 5891m)`
);
