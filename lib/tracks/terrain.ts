import type { TrackData } from "./types";
import { GRASS_BELOW_TRACK_METERS } from "./mesh";
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
 * centimetres, and the nearest point is the whole rule.
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

  return { positions, indices, columns, rows, originX, originZ, cellMeters };
}
