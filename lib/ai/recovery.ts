// Recovery for AI cars that are beached, wedged or upside down: after a few
// seconds of going nowhere (and not merely queueing behind a stopped car -
// racecraft reports that as `blocked`), the car is put back on the racing
// line at its own progress, facing down the road, once no other car is
// close enough to be landed on. Shared by AICar.tsx and the headless field
// sim so a race gate measures the same recovery the game runs.
import type { RacingLinePoint } from "../tracks/racingLine";
import { SPAWN_CLEARANCE_METERS } from "../race/grid";

const STUCK_SPEED_MS = 1.5;
const STUCK_SECONDS = 5;
/** Body up-vector y below this is past ~70 degrees of tilt. */
const FLIPPED_UP_Y = 0.35;
const FLIPPED_SECONDS = 2;
/** No other car within this many meters of track either way. */
const CLEAR_GAP_METERS = 12;

export interface RecoveryState {
  stuckSeconds: number;
  flippedSeconds: number;
}

export function createRecoveryState(): RecoveryState {
  return { stuckSeconds: 0, flippedSeconds: 0 };
}

/**
 * Advance the stuck/flipped clocks; true when the car should be recovered
 * now. The caller still checks isRecoverySpotClear before moving it (and
 * simply asks again next tick when it isn't).
 */
export function updateRecovery(
  state: RecoveryState,
  args: { racing: boolean; speedMs: number; upY: number; blocked: boolean; dt: number }
): boolean {
  if (!args.racing) {
    state.stuckSeconds = 0;
    state.flippedSeconds = 0;
    return false;
  }
  state.flippedSeconds = args.upY < FLIPPED_UP_Y ? state.flippedSeconds + args.dt : 0;
  // Queued behind a stopped car counts at a third of the rate: waiting is
  // normal, waiting for fifteen seconds is a jam.
  state.stuckSeconds =
    Math.abs(args.speedMs) < STUCK_SPEED_MS ? state.stuckSeconds + args.dt * (args.blocked ? 1 / 3 : 1) : 0;
  return state.flippedSeconds > FLIPPED_SECONDS || state.stuckSeconds > STUCK_SECONDS;
}

/** How far down the road a jammed car may be moved to find clear track. */
const SEARCH_AHEAD_METERS = 120;

/**
 * First line index at or ahead of `anchor` with no other car within
 * CLEAR_GAP_METERS of track, given every other car's gap from this car -
 * or null when nothing within reach is clear (the caller asks again next
 * tick). Usually the car's own spot; a car jammed behind a stationary one
 * lands just past it.
 */
export function findRecoveryIndex(
  line: RacingLinePoint[],
  anchor: number,
  gapsMeters: readonly number[]
): number | null {
  const n = line.length;
  let ahead = 0;
  for (let k = 0; k < n && ahead <= SEARCH_AHEAD_METERS; k++) {
    if (gapsMeters.every((gap) => Math.abs(gap - ahead) > CLEAR_GAP_METERS)) return (anchor + k) % n;
    ahead += line[(anchor + k) % n].distanceToNextMeters;
  }
  return null;
}

/** Pose on the racing line at `index`, heading along it (yaw uses the
 * vehicle convention: forward is (-sin yaw, -cos yaw)). */
export function recoveryPose(
  line: RacingLinePoint[],
  index: number
): { x: number; y: number; z: number; yaw: number } {
  const n = line.length;
  const here = line[((index % n) + n) % n].position;
  const next = line[(((index + 2) % n) + n) % n].position;
  return {
    x: here[0],
    y: here[1] + SPAWN_CLEARANCE_METERS,
    z: here[2],
    yaw: Math.atan2(-(next[0] - here[0]), -(next[2] - here[2])),
  };
}
