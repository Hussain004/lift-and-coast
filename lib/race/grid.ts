import type { TrackData } from "../tracks/types";

// Plan section 7 (real grids): qualifying sets the order, and the race
// starts staggered - pole at the line, P2 a car length-plus behind -
// instead of the old side-by-side spawn. The behind car also needs its lap
// timer told (see startsBehindLine in lapTimer.ts) or the run up to the
// line records a bogus ~2s lap.
export const GRID_BEHIND_METERS = 8;

/** Lateral offset fraction both cars keep from their equal-start spots. */
export const GRID_OFFSET_FRACTION_OF_HALF_WIDTH = 0.35;

export interface GridSpawn {
  x: number;
  /** Ground elevation under the slot plus spawn clearance (see
   * SPAWN_CLEARANCE_METERS) - never a flat y=1, which buries back-grid
   * cars on tracks with elevation (Suzuka's final sector climbs ~2m
   * across the grid: buried chassis grind the solver into NaN, freezing
   * the whole session). */
  y: number;
  z: number;
  startsBehindLine: boolean;
}

/** Chassis spawn height above the ground. */
export const SPAWN_CLEARANCE_METERS = 1;

function frame(track: TrackData): {
  forwardX: number;
  forwardZ: number;
  rightX: number;
  rightZ: number;
} {
  const yaw = track.startPos.headingRad;
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  return { forwardX, forwardZ, rightX: -forwardZ, rightZ: forwardX };
}

/**
 * Ground elevation (centerline y) under a world position - for spawns and
 * resets, which must sit relative to the surface, never at a flat height.
 * Height-aware like checkTrackLimits (see its y param): under the
 * crossover the two decks disagree, and the caller passes its own height.
 */
export function groundElevationAt(track: TrackData, x: number, z: number, y?: number): number {
  let best = 0;
  let bestSq = Infinity;
  for (const [cx, cy, cz] of track.centerline) {
    const distSq = (cx - x) ** 2 + (cz - z) ** 2 + (y !== undefined ? (cy - y) ** 2 : 0);
    if (distSq < bestSq) {
      bestSq = distSq;
      best = cy;
    }
  }
  return best;
}

/**
 * Spawn for a grid slot (0-based: slot 0 is pole). The field forms two
 * columns with F1-style stagger - pole sits at the line on the centerline
 * (the exact historical P1 spawn), every other car sits a row
 * (GRID_BEHIND_METERS) back per pair, alternating sides, with the behind
 * car's lap timer forgiving the run up to the line (see startsBehindLine
 * in lapTimer.ts). Callers map an absent ?grid= to slot 0 for the player,
 * so un-gridded sessions start staggered from pole: the old side-by-side
 * P2 never got 3m behind the line, so its timer could never arm and its
 * first crossing mis-recorded - every car behind the line now arms
 * correctly by construction.
 */
export function gridSlot(track: TrackData, slot: number): GridSpawn {
  const { forwardX, forwardZ, rightX, rightZ } = frame(track);
  const halfWidth = track.width[0] / 2;
  const lateral =
    slot === 0 ? 0 : (slot % 2 === 0 ? -1 : 1) * halfWidth * GRID_OFFSET_FRACTION_OF_HALF_WIDTH;
  const behind = Math.ceil(slot / 2) * GRID_BEHIND_METERS;
  const x = track.startPos.x + rightX * lateral - forwardX * behind;
  const z = track.startPos.z + rightZ * lateral - forwardZ * behind;
  return {
    x,
    y: groundElevationAt(track, x, z) + SPAWN_CLEARANCE_METERS,
    z,
    startsBehindLine: behind > 0,
  };
}
