import type { TrackData } from "./types";
import { buildRibbonGeometry, GRASS_BELOW_TRACK_METERS } from "./mesh";
import { worldEdgeResetMeters } from "./trackLimits";

/**
 * The grass/runoff surface the cars land on when they leave the ribbon.
 *
 * It used to be one flat 2500m box (Scene.tsx) / 1250m cuboid (the harness).
 * That is only correct while the centerline is flat: the moment it carries
 * real elevation (see scripts/build-track.mts) a single flat plane is at the
 * wrong height almost everywhere, and a car that runs wide at Spa would drop
 * up to ~50m to reach it. So the runoff is now a coarse height field sampled
 * from the circuit's own profile, minus GRASS_BELOW_TRACK_METERS so a wheel
 * never pings between the two colliders (the same gap the old plane used, see
 * mesh.ts).
 *
 * Each vertex takes the elevation of the *nearest* centerline point. That is
 * only a safe rule because the track's own elevation is averaged in 2D (see
 * averageElevations in scripts/build-track.mts) rather than along the lap,
 * which makes the two arms of a self-crossing agree wherever they touch:
 * Suzuka's arms pass within ~1m of each other and a nearest-point field has
 * to switch between them somewhere, so if their heights differed there the
 * switch would be a several-metre step through whichever arm lost - a wall
 * inside the lower straight, or a hole under the upper one. With a 2D
 * neighbourhood both arms report the same hill, the switch is worth
 * centimetres, and the nearest point is almost the whole rule: one
 * post-pass below (applyRibbonClearance) additionally pushes down the
 * vertices of any terrain triangle that would otherwise sit above the
 * ribbon it spans, because sampling per vertex cannot see that the
 * renderer interpolates across whole triangles.
 *
 * The one thing a nearest-point field cannot do is bank gently. Where two
 * parts of a lap come close *and* sit at genuinely different heights - the
 * two sides of a hairpin cut into a hillside - the ground between them has to
 * climb from one to the other, and with 12.5m cells it climbs inside one or
 * two cells. That is a steep bank in the grass a wheel's width from the
 * ribbon edge (measured worst case ~1.2m of rise per 2m of travel, at Spa and
 * Suzuka); a real circuit would have the barrier and the gravel there instead.
 * Making the cells finer only narrows the bank, so this is a deliberate
 * trade of a coarse grid for a cheap one.
 *
 * This is terrain *derived from the track*, not a real DEM of the
 * surroundings - the DEM that supplies the track's elevation is itself only
 * 90m-per-sample and would be no more truthful out here.
 *
 * Deterministic, and cached per TrackData object: the harness builds a whole
 * physics world per scenario and must not pay for the same field every time.
 */
export const TERRAIN_CELL_METERS = 12.5;
/**
 * How far the field extends past the radius a car is teleported back to the
 * start line from (see worldEdgeResetMeters in trackLimits.ts). Only has to
 * be positive - it guarantees that backstop fires while the car is still
 * standing on the ground, so nothing can drive off the finite field and fall
 * forever, which is the physics-engine crash the reset exists to prevent.
 */
export const TERRAIN_OUTER_MARGIN_METERS = 200;

export interface TerrainGeometry {
  /** [x, y, z, ...] vertex positions, row-major in z. */
  positions: Float32Array;
  /** Triangle vertex indices, wound counter-clockwise seen from above. */
  indices: Uint32Array;
  /** Grid dimensions and placement, exposed for tests and diagnostics. */
  columns: number;
  rows: number;
  originX: number;
  originZ: number;
  cellMeters: number;
}

const cache = new WeakMap<TrackData, TerrainGeometry>();

/**
 * Builds (once per track object) the grass field as a trimesh, the same shape
 * buildRibbonGeometry returns so both Scene.tsx and lib/ai/harness.ts can
 * hand it straight to a TrimeshCollider and prove they agree.
 */
export function buildTerrainGeometry(track: TrackData): TerrainGeometry {
  const cached = cache.get(track);
  if (cached) return cached;
  const built = computeTerrain(track);
  cache.set(track, built);
  return built;
}

function computeTerrain(track: TrackData): TerrainGeometry {
  const count = track.centerline.length;
  // Flat typed arrays for the scan below: it is the one
  // O(vertices x centerline points) loop in the build, so destructuring a
  // tuple per point per vertex is worth avoiding.
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = track.centerline[i];
    cx[i] = x;
    cy[i] = y;
    cz[i] = z;
  }

  // Square, centred on the projection origin (the same origin the reset
  // measures from), and sized from the reset radius so the two can never
  // disagree about where the ground ends.
  const half = worldEdgeResetMeters(track) + TERRAIN_OUTER_MARGIN_METERS;
  const cellMeters = TERRAIN_CELL_METERS;
  const columns = Math.ceil((half * 2) / cellMeters) + 1;
  const rows = columns;
  const originX = -half;
  const originZ = -half;

  const positions = new Float32Array(columns * rows * 3);
  for (let row = 0; row < rows; row++) {
    const z = originZ + row * cellMeters;
    for (let column = 0; column < columns; column++) {
      const x = originX + column * cellMeters;

      let nearestSq = Infinity;
      let height = 0;
      for (let i = 0; i < count; i++) {
        const dx = x - cx[i];
        const dz = z - cz[i];
        const distSq = dx * dx + dz * dz;
        if (distSq < nearestSq) {
          nearestSq = distSq;
          height = cy[i];
        }
      }

      const offset = (row * columns + column) * 3;
      positions[offset] = x;
      positions[offset + 1] = height - GRASS_BELOW_TRACK_METERS;
      positions[offset + 2] = z;
    }
  }

  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  let write = 0;
  for (let row = 0; row < rows - 1; row++) {
    for (let column = 0; column < columns - 1; column++) {
      const a = row * columns + column;
      const right = a + 1;
      const down = a + columns;
      const downRight = down + 1;
      indices[write++] = a;
      indices[write++] = down;
      indices[write++] = downRight;
      indices[write++] = a;
      indices[write++] = downRight;
      indices[write++] = right;
    }
  }

  // The nearest-point rule sets each vertex, but the renderer and the
  // collider both interpolate across whole 12.5m triangles: where the
  // asphalt climbs or drops inside one cell, a triangle spanning it can sit
  // above the ribbon it covers and hide that stretch of road (measured worst
  // ~0.4m, most often on Suzuka). So push down every terrain vertex just
  // enough that no terrain triangle rises above the ribbon anywhere the two
  // overlap - evaluated over the exact overlap polygon, not just at shared
  // vertices, since the difference of two planar triangles is linear and
  // therefore worst at a polygon corner.
  applyRibbonClearance(track, positions, columns, rows, originX, originZ, cellMeters);

  return { positions, indices, columns, rows, originX, originZ, cellMeters };
}

interface PlanCorner {
  x: number;
  z: number;
  y: number;
}

type PlanTriangle = [PlanCorner, PlanCorner, PlanCorner];

function planArea(a: PlanCorner, b: PlanCorner, c: PlanCorner): number {
  return (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
}

/** Barycentric weights of (x, z) in t, or null when t is degenerate in plan. */
function planBarycentric(t: PlanTriangle, x: number, z: number): [number, number, number] | null {
  const [a, b, c] = t;
  const area = planArea(a, b, c);
  if (Math.abs(area) < 1e-12) return null;
  const p: PlanCorner = { x, z, y: 0 };
  const l1 = planArea(p, b, c) / area;
  const l2 = planArea(p, c, a) / area;
  return [l1, l2, 1 - l1 - l2];
}

function planHeight(t: PlanTriangle, weights: [number, number, number]): number {
  return weights[0] * t[0].y + weights[1] * t[1].y + weights[2] * t[2].y;
}

/** Intersection of segments p1-p2 and p3-p4 in plan, or null when apart. */
function planSegmentIntersection(
  p1: PlanCorner,
  p2: PlanCorner,
  p3: PlanCorner,
  p4: PlanCorner
): { x: number; z: number } | null {
  const dx1 = p2.x - p1.x;
  const dz1 = p2.z - p1.z;
  const dx2 = p4.x - p3.x;
  const dz2 = p4.z - p3.z;
  const denom = dx1 * dz2 - dz1 * dx2;
  if (Math.abs(denom) < 1e-12) return null;
  const t = ((p3.x - p1.x) * dz2 - (p3.z - p1.z) * dx2) / denom;
  const u = ((p3.x - p1.x) * dz1 - (p3.z - p1.z) * dx1) / denom;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: p1.x + t * dx1, z: p1.z + t * dz1 };
}

/**
 * Largest amount by which terrain triangle t rises above ribbon triangle r
 * anywhere the two overlap in plan (-Infinity when they do not overlap).
 * Both are planar, so their difference is linear over the convex overlap
 * polygon and worst at one of its corners: a t corner inside r, an r corner
 * inside t, or an edge crossing.
 */
function ribbonOverlapExcess(t: PlanTriangle, r: PlanTriangle): number {
  let excess = -Infinity;
  const consider = (x: number, z: number) => {
    const bt = planBarycentric(t, x, z);
    const br = planBarycentric(r, x, z);
    if (!bt || !br) return;
    if (bt.some((w) => w < -1e-7) || br.some((w) => w < -1e-7)) return;
    const over = planHeight(t, bt) - planHeight(r, br);
    if (over > excess) excess = over;
  };
  for (const c of t) consider(c.x, c.z);
  for (const c of r) consider(c.x, c.z);
  const tEdges: [PlanCorner, PlanCorner][] = [
    [t[0], t[1]],
    [t[1], t[2]],
    [t[2], t[0]],
  ];
  const rEdges: [PlanCorner, PlanCorner][] = [
    [r[0], r[1]],
    [r[1], r[2]],
    [r[2], r[0]],
  ];
  for (const [p1, p2] of tEdges) {
    for (const [p3, p4] of rEdges) {
      const hit = planSegmentIntersection(p1, p2, p3, p4);
      if (hit) consider(hit.x, hit.z);
    }
  }
  return excess;
}

function applyRibbonClearance(
  track: TrackData,
  positions: Float32Array,
  columns: number,
  rows: number,
  originX: number,
  originZ: number,
  cellMeters: number
): void {
  const ribbon = buildRibbonGeometry(track);
  const rp = ribbon.positions;
  const ri = ribbon.indices;
  const corner = (vertex: number): PlanCorner => ({
    x: rp[vertex * 3],
    z: rp[vertex * 3 + 2],
    y: rp[vertex * 3 + 1],
  });
  // Per-vertex drops, combined with max (never summed): lowering every
  // corner of an overlapping terrain triangle by its own required drop keeps
  // that triangle clear, and a corner shared with a needier neighbour only
  // drops further, never back above the ribbon.
  const drops = new Float32Array(columns * rows);
  // A hair past the nominal gap so float32 storage rounding cannot leave a
  // sample exactly flush (the regression test allows 0.1mm either way).
  const target = GRASS_BELOW_TRACK_METERS + 0.0005;

  for (let r = 0; r < ri.length; r += 3) {
    const tri: PlanTriangle = [corner(ri[r]), corner(ri[r + 1]), corner(ri[r + 2])];
    if (Math.abs(planArea(tri[0], tri[1], tri[2])) < 1e-9) continue;
    const minX = Math.min(tri[0].x, tri[1].x, tri[2].x);
    const maxX = Math.max(tri[0].x, tri[1].x, tri[2].x);
    const minZ = Math.min(tri[0].z, tri[1].z, tri[2].z);
    const maxZ = Math.max(tri[0].z, tri[1].z, tri[2].z);
    const c0 = Math.max(0, Math.floor((minX - originX) / cellMeters));
    const c1 = Math.min(columns - 2, Math.floor((maxX - originX) / cellMeters));
    const r0 = Math.max(0, Math.floor((minZ - originZ) / cellMeters));
    const r1 = Math.min(rows - 2, Math.floor((maxZ - originZ) / cellMeters));
    for (let row = r0; row <= r1; row++) {
      for (let column = c0; column <= c1; column++) {
        const a = row * columns + column;
        const right = a + 1;
        const down = a + columns;
        const downRight = down + 1;
        // Same two triangles the index buffer emits for this cell.
        for (const cell of [
          [a, down, downRight],
          [a, downRight, right],
        ]) {
          const t: PlanTriangle = cell.map((v) => ({
            x: positions[v * 3],
            z: positions[v * 3 + 2],
            y: positions[v * 3 + 1],
          })) as PlanTriangle;
          if (
            Math.max(t[0].x, t[1].x, t[2].x) < minX ||
            Math.min(t[0].x, t[1].x, t[2].x) > maxX ||
            Math.max(t[0].z, t[1].z, t[2].z) < minZ ||
            Math.min(t[0].z, t[1].z, t[2].z) > maxZ
          ) {
            continue;
          }
          const excess = ribbonOverlapExcess(t, tri);
          if (excess === -Infinity) continue;
          const need = excess + target;
          if (need <= 0) continue;
          for (const v of cell) {
            if (need > drops[v]) drops[v] = need;
          }
        }
      }
    }
  }

  for (let v = 0; v < drops.length; v++) {
    if (drops[v] > 0) positions[v * 3 + 1] -= drops[v];
  }
}
