import type { TrackData } from "./types";
import {
  TRACK_EDGE_MARGIN_METERS,
  WORLD_EDGE_RESET_METERS,
} from "../physics/vehicle";

// ---------------------------------------------------------------------------
// Cached spatial index (2D uniform grid) per track.
// ---------------------------------------------------------------------------

/**
 * A cached uniform-grid index over a track's centerline. Building it is
 * O(n); querying it is O(k) for the few cells around the query point
 * instead of an O(n) scan of all 1,700-3,000 centerline points.
 *
 * Before this, every physics tick each car paid ~9 FULL centerline scans
 * (chassis limit + 4 wheel surfaces + 4 off-track wheel checks), i.e.
 * hundreds of millions of distance computations/second across a 21-car
 * field at 60Hz - the single largest CPU consumer in the game.
 *
 * Cell size = max track half-width + margin, so ANY centerline point
 * within halfWidth + margin of a query lies in the 3x3 cells around it:
 * a point further than one cell away in either axis cannot be inside
 * the 3x3 search box. Queries outside the indexed area (car far off
 * track) fall back to a full scan - rare, and still correct.
 */
const GRID_CELL_SIZE_METER_MARGIN = 30;

interface CenterlineGrid {
  cellSize: number;
  /** cellKey (cx + cz * 4096) -> sorted centerline indices. */
  cells: Map<number, number[]>;
}

const trackGridCache = new WeakMap<TrackData, CenterlineGrid>();

function trackGrid(track: TrackData): CenterlineGrid {
  let grid = trackGridCache.get(track);
  if (grid) return grid;
  // Cell size must exceed the largest half-width + search margin, or the
  // 3x3 neighborhood guarantee breaks. Compute the real bound from data.
  let maxHalfWidth = 0;
  for (let i = 0; i < track.width.length; i++) {
    if (track.width[i] / 2 > maxHalfWidth) maxHalfWidth = track.width[i] / 2;
  }
  const cellSize = maxHalfWidth + GRID_CELL_SIZE_METER_MARGIN;
  const cells = new Map<number, number[]>();
  for (let i = 0; i < track.centerline.length; i++) {
    const [cx, , cz] = track.centerline[i];
    const key = cellKeyFor(Math.floor(cx / cellSize), Math.floor(cz / cellSize));
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(i);
  }
  grid = { cellSize, cells };
  trackGridCache.set(track, grid);
  return grid;
}

function cellKeyFor(gx: number, gz: number): number {
  // 4096^2 cell space centered on origin: far more than any circuit spans.
  return (gx + 2048) + (gz + 2048) * 4096;
}

/**
 * Nearest-centerline-point via the grid. Returns null when the query is
 * far outside every indexed cell (car lost way off track) - the caller
 * decides what that means (the fallback below re-runs a full scan, which
 * is fine because it happens a handful of times a race, not per tick).
 */
function nearestViaGrid(
  track: TrackData,
  x: number,
  z: number,
  y: number | undefined
): { idx: number; distSq: number } | null {
  const grid = trackGrid(track);
  const gx = Math.floor(x / grid.cellSize);
  const gz = Math.floor(z / grid.cellSize);
  let nearestIdx = -1;
  let nearestDistSq = Infinity;
  for (let ox = -1; ox <= 1; ox++) {
    for (let oz = -1; oz <= 1; oz++) {
      const bucket = grid.cells.get(cellKeyFor(gx + ox, gz + oz));
      if (!bucket) continue;
      for (let bi = 0; bi < bucket.length; bi++) {
        const i = bucket[bi];
        const [cx, cy, cz] = track.centerline[i];
        const distSq =
          (cx - x) ** 2 + (cz - z) ** 2 + (y !== undefined ? (cy - y) ** 2 : 0);
        if (distSq < nearestDistSq) {
          nearestDistSq = distSq;
          nearestIdx = i;
        }
      }
    }
  }
  if (nearestIdx < 0) return null;
  // Correctness bound: the 3x3 box covers every point within one cell of
  // the query (a point within cellSize lies in gx-1..gx+1 / gz-1..gz+1 by
  // construction). If the box winner is farther than that, a closer point
  // could live outside the box - report "no hit" and let the fallback
  // full-scan decide. On-track queries always sit well inside one cell,
  // so this only ever triggers far off track.
  if (nearestDistSq > grid.cellSize * grid.cellSize) return null;
  return { idx: nearestIdx, distSq: nearestDistSq };
}

function nearestCenterline(
  track: TrackData,
  x: number,
  z: number,
  y?: number
): { idx: number; distSq: number } {
  const hit = nearestViaGrid(track, x, z, y);
  if (hit) return hit;
  // Fallback: full brute scan (car far off track / outside the grid).
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < track.centerline.length; i++) {
    const [cx, cy, cz] = track.centerline[i];
    const distSq = (cx - x) ** 2 + (cz - z) ** 2 + (y !== undefined ? (cy - y) ** 2 : 0);
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  return { idx: nearestIdx, distSq: nearestDistSq };
}

/**
 * Nearest centerline point to (x, z[, y]), cached-grid accelerated.
 * Result is identical to the previous brute-force scan (nearest wins
 * ties the same way - strictly-less comparison over ascending indices
 * within each bucket, and the buckets partition the same candidate set
 * the scan would win from), just without the per-tick O(n) cost.
 */
export function nearestCenterlineIndex(
  track: TrackData,
  x: number,
  z: number,
  y?: number
): { nearestIndex: number; distSq: number } {
  const { idx, distSq } = nearestCenterline(track, x, z, y);
  return { nearestIndex: idx, distSq };
}

export interface TrackLimitStatus {
  /** 0 if within the track's width, meters past the edge otherwise. */
  distanceFromEdgeMeters: number;
  isOffTrack: boolean;
  /**
   * Arc-length distance along the centerline from the start/finish line to
   * the nearest centerline point, in meters - the same nearest-point search
   * this function already does, exposed for the delta timer (see
   * lib/race/deltaTimer.ts) instead of a second brute-force scan per frame.
   * Wraps to ~0 at the start/finish line, since track.centerline[0] is
   * startPos (verified against the real track data).
   */
  progressMeters: number;
  /**
   * Signed lateral offset from the nearest centerline point, in meters,
   * positive to the right of the direction of travel. Same magnitude as the
   * nearest-point distance (before the half-width is subtracted), exposed for
   * the surface classifier (see lib/tracks/surfaces.ts) so it can tell which
   * side of the track a wheel is on - and therefore which side's kerb,
   * gravel or grass.
   */
  lateralMeters: number;
  /** Index of the nearest centerline point, for per-point zone lookups. */
  nearestIndex: number;
}

/**
 * Brute-force nearest centerline point. Originally O(n) per call with one
 * call per rendered frame - trivial for a single car, but with 21 cars
 * calling it ~9x per physics tick it was hundreds of millions of distance
 * computations per second, so it now runs on the cached spatial grid above
 * (identical results, O(k) per query; full scan only as an off-track
 * fallback). The doc comment below is about the *deck disambiguation*,
 * which is the part that still matters at the call sites.
 *
 * Pass y (chassis height) wherever the caller has it: the figure-8
 * crossover decks sit 6m apart in height at the same plan position, and
 * a 2D search snaps cars between decks (progress jumps half a lap,
 * wrong-side kerbs). With y, the search is 3D and each deck finds its
 * own layer; elsewhere the heights agree to centimetres so results are
 * unchanged. Callers without a height (tests, reset backstops) keep 2D.
 */
export function checkTrackLimits(track: TrackData, x: number, z: number, y?: number): TrackLimitStatus {
  const { idx: nearestIdx, distSq: nearestDistSq } = nearestCenterline(track, x, z, y);
  const halfWidth = track.width[nearestIdx] / 2;
  const distanceFromEdgeMeters = Math.max(0, Math.sqrt(nearestDistSq) - halfWidth);
  const progressMeters = (nearestIdx / track.centerline.length) * track.lengthMeters;
  // Which side of the centerline the point is on: project onto the local
  // right vector (same right = (-tangentZ, tangentX) convention as
  // buildRibbonGeometry's offsets).
  const n = track.centerline.length;
  const before = track.centerline[(nearestIdx - 1 + n) % n];
  const after = track.centerline[(nearestIdx + 1) % n];
  const tangentX = after[0] - before[0];
  const tangentZ = after[2] - before[2];
  const tangentLength = Math.hypot(tangentX, tangentZ) || 1;
  const rightX = -tangentZ / tangentLength;
  const rightZ = tangentX / tangentLength;
  const center = track.centerline[nearestIdx];
  const side = (x - center[0]) * rightX + (z - center[2]) * rightZ;
  const distance = Math.sqrt(nearestDistSq);
  const lateralMeters = (side < 0 ? -1 : 1) * distance;
  return {
    distanceFromEdgeMeters,
    isOffTrack: distanceFromEdgeMeters > 0,
    progressMeters,
    lateralMeters,
    nearestIndex: nearestIdx,
  };
}

// Plan section 5, depth feature 6 (kerb & surface interaction) / section 4
// point 7 (surface zones): grass (no authored per-zone tags for it in the
// track data) reuses this module's falloff, the pre-zone approximation it
// has always shipped - surfaces.ts classifies the track's own authored
// surface zones (kerb/gravel) and delegates everything past them here via
// the same distanceFromEdgeMeters this module already computes, rather than
// a second geometry system. Grip falls off smoothly over the first few
// meters past the edge (where real grass starts mattering) down to a
// still-drivable floor: harsh enough to be a real penalty, gentle enough
// that a wide exit never snowballs into an unrecoverable slide (see the
// floor note in surfaces.ts - the per-track AI gate measured the 0.35 floor
// doing exactly that on Suzuka). Never an instant on/off
// track-limits-style cliff.
const SURFACE_GRIP_FALLOFF_METERS = 4;
const MIN_SURFACE_GRIP_FRACTION = 0.6;

/**
 * A below-1x-only grip multiplier for driving off the track surface -
 * follows the same "only ever shrinks an existing safe product" pattern as
 * the aero and tire compound grip scales in vehicle.ts/tireModel.ts, so it
 * composes with them without needing new stability verification.
 */
export function computeSurfaceGripMultiplier(distanceFromEdgeMeters: number): number {
  if (distanceFromEdgeMeters <= 0) return 1;
  const t = Math.min(1, distanceFromEdgeMeters / SURFACE_GRIP_FALLOFF_METERS);
  return 1 - t * (1 - MIN_SURFACE_GRIP_FRACTION);
}

/**
 * The real track-limits rule (plan section 5, depth feature 7): a lap is
 * only invalidated when ALL FOUR wheels are off the track, not the chassis
 * center - a single wheel still touching keeps the lap legal, same as real
 * regulations, and avoids penalizing a car that's mostly still on track
 * through a wide corner exit. The HUD's real-time "TRACK LIMITS" warning
 * fires on this same rule (see Car.tsx), so the warning and the penalty
 * can never disagree about what's legal.
 */
export function allWheelsOffTrack(
  track: TrackData,
  wheelPositions: { x: number; z: number }[]
): boolean {
  return wheelPositions.every((p) => checkTrackLimits(track, p.x, p.z).isOffTrack);
}

/**
 * Distance from the track's projection origin reached by its furthest
 * centerline point - the radius every point of the racing surface sits
 * inside. Used to size the two things that must contain the whole circuit:
 * the world-edge reset radius below and the built grass field (see
 * lib/tracks/terrain.ts).
 */
export function trackExtentMeters(track: TrackData): number {
  let extent = 0;
  for (let i = 0; i < track.centerline.length; i++) {
    const [x, , z] = track.centerline[i];
    const radius = Math.hypot(x, z);
    if (radius > extent) extent = radius;
  }
  return extent;
}

/**
 * Absolute-distance backstop for a car that has driven off the end of the
 * circuit entirely - see WORLD_EDGE_RESET_METERS and
 * TRACK_EDGE_MARGIN_METERS. Track-relative rather than a bare constant: the
 * guard exists to stop a car leaving the finite ground field, so a circuit
 * larger than the constant has to push the boundary out with it, or the
 * reset fires on ordinary racing surface.
 */
export function worldEdgeResetMeters(track: TrackData): number {
  return Math.max(
    WORLD_EDGE_RESET_METERS,
    trackExtentMeters(track) + TRACK_EDGE_MARGIN_METERS
  );
}
