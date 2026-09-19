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
  z: number;
  startsBehindLine: boolean;
}

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
  return {
    x: track.startPos.x + rightX * lateral - forwardX * behind,
    z: track.startPos.z + rightZ * lateral - forwardZ * behind,
    startsBehindLine: behind > 0,
  };
}
