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
 * Spawn for one car. `playerSpot` is the PLAYER's spot (1|2) or null for
 * the old equal standing start; `isPlayer` picks which car this is for.
 * P1 keeps the exact historical spawn (center for the player, lateral
 * offset for the AI) so un-gridded sessions behave byte-identically; P2
 * sits GRID_BEHIND_METERS back on the same lateral.
 */
export function gridSpawn(
  track: TrackData,
  playerSpot: 1 | 2 | null,
  isPlayer: boolean
): GridSpawn {
  const { forwardX, forwardZ, rightX, rightZ } = frame(track);
  const lateral = isPlayer ? 0 : (track.width[0] / 2) * GRID_OFFSET_FRACTION_OF_HALF_WIDTH;
  const isBehind =
    playerSpot !== null && (playerSpot === 1) !== isPlayer;
  const behind = isBehind ? GRID_BEHIND_METERS : 0;
  return {
    x: track.startPos.x + rightX * lateral - forwardX * behind,
    z: track.startPos.z + rightZ * lateral - forwardZ * behind,
    startsBehindLine: behind > 0,
  };
}
