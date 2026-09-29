// An AI car's pit stop, as a scripted run along the pit lane. The path
// follower and the vehicle physics are NOT involved (they are chaotic and
// tuned for the racing line): at the pit entry the car is parked on a
// kinematic body, this module says where it is each tick, and at the exit
// the AI gets a normal dynamic body back, pointing along the road at lane
// speed. Pure - AICar.tsx applies the poses.
import { PIT_SPEED_LIMIT_MS, type PitLane } from "../tracks/pitLane";
import type { TrackData } from "../tracks/types";

export interface PitPath {
  xs: Float32Array;
  ys: Float32Array;
  zs: Float32Array;
  yaws: Float32Array;
  /** Cumulative arc length at each point, metres. */
  cum: Float32Array;
  /** Arc position of the box, of the lane exit, and the total length. */
  boxS: number;
  exitS: number;
  total: number;
}

export interface PitRunState {
  s: number;
  v: number;
  phase: "run" | "stopped" | "leave";
  stopLeft: number;
  done: boolean;
}

/** Hard braking into the lane, and how quickly the car picks up after the exit. */
const BRAKE_MS2 = 32;
const STOP_BRAKE_MS2 = 6;
const ACCEL_MS2 = 9;
/** Speed the car is handed back to the AI at. */
export const PIT_EXIT_SPEED_MS = 30;
const BLEND_METERS = 40;
const REJOIN_METERS = 90;
/** Spacing between AI boxes, metres, counted back from the player's box. */
export const AI_BOX_SPACING_METERS = 12;

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

/** Which lap (1-based, the lap it pits at the end of) a driver stops on, or null for no stop. */
export function planPitLap(raceLaps: number, driverHash: number, override: number | null = null): number | null {
  if (override !== null) return Math.max(0, Math.min(raceLaps - 1, override));
  if (raceLaps < 5) return null;
  const centre = Math.round(raceLaps * 0.5);
  const jitter = (driverHash % 3) - 1; // -1, 0 or +1 laps around half distance
  return Math.max(2, Math.min(raceLaps - 1, centre + jitter));
}

/**
 * The route from where the car is now (startIndex on the centreline, at
 * startLateral from it) into the lane, down to its box, and back out to the
 * racing line. `boxSlot` picks its box: 0 is the player's, then back along
 * the lane.
 */
export function buildPitPath(
  track: TrackData,
  lane: PitLane,
  startIndex: number,
  startLateral: number,
  bodyHeight: number,
  boxSlot: number
): PitPath {
  const n = track.centerline.length;
  const spacing = track.lengthMeters / n;
  // Walk the centreline from the start to the lane exit, then on to rejoin.
  // A car already inside the lane's stretch (a grid slot, in practice) joins it where it is.
  const fromEntry = (((startIndex - lane.entryIndex) % n) + n) % n;
  const inSpan = fromEntry <= lane.span - 1;
  const toEntry = inSpan ? 0 : (((lane.entryIndex - startIndex) % n) + n) % n;
  const laneSpan = inSpan ? lane.span - 1 - fromEntry : lane.span - 1;
  const rejoin = Math.round(REJOIN_METERS / spacing);
  const count = toEntry + laneSpan + rejoin + 1;
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const zs = new Float32Array(count);
  const yaws = new Float32Array(count);
  const cum = new Float32Array(count);
  const blend = Math.max(1, Math.round(BLEND_METERS / spacing));
  let laneEndOffset = 0;
  for (let k = 0; k < count; k++) {
    const i = (startIndex + k) % n;
    const inLane = k >= toEntry && k <= toEntry + laneSpan;
    let offset: number;
    if (k < toEntry) {
      offset = startLateral;
    } else if (inLane) {
      const laneOffset = lane.offsetByIndex[i];
      offset = startLateral + (laneOffset - startLateral) * smoothstep((k - toEntry) / blend);
      laneEndOffset = laneOffset;
    } else {
      offset = laneEndOffset * (1 - smoothstep((k - toEntry - laneSpan) / rejoin));
    }
    const before = track.centerline[(i - 1 + n) % n];
    const after = track.centerline[(i + 1) % n];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const len = Math.hypot(tx, tz) || 1;
    const c = track.centerline[i];
    xs[k] = c[0] + (-tz / len) * offset;
    zs[k] = c[2] + (tx / len) * offset;
    ys[k] = c[1] + bodyHeight;
    yaws[k] = Math.atan2(-tx, -tz);
    cum[k] = k === 0 ? 0 : cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], zs[k] - zs[k - 1]);
  }
  const boxK = ((((lane.box.index - startIndex) % n) + n) % n) - Math.round((boxSlot * AI_BOX_SPACING_METERS) / spacing);
  const boxKClamped = Math.min(toEntry + laneSpan - 4, Math.max(toEntry + Math.min(Math.round(120 / spacing), laneSpan - 8), boxK));
  return {
    xs,
    ys,
    zs,
    yaws,
    cum,
    boxS: cum[boxKClamped],
    exitS: cum[toEntry + laneSpan],
    total: cum[count - 1],
  };
}

export function startPitRun(speedMs: number): PitRunState {
  return { s: 0, v: Math.max(0, speedMs), phase: "run", stopLeft: 0, done: false };
}

/** Advances the run by dt. `stopSeconds` is how long the car sits in its box. */
export function stepPitRun(state: PitRunState, path: PitPath, dt: number, stopSeconds: number): void {
  if (state.done) return;
  if (state.phase === "stopped") {
    state.stopLeft -= dt;
    if (state.stopLeft <= 0) state.phase = "leave";
    return;
  }
  let target: number;
  if (state.phase === "run") {
    const toBox = Math.max(0, path.boxS - state.s);
    target = Math.min(PIT_SPEED_LIMIT_MS, Math.sqrt(2 * STOP_BRAKE_MS2 * toBox));
  } else if (state.s < path.exitS) {
    target = PIT_SPEED_LIMIT_MS;
  } else {
    target = PIT_EXIT_SPEED_MS;
  }
  state.v = state.v > target ? Math.max(target, state.v - BRAKE_MS2 * dt) : Math.min(target, state.v + ACCEL_MS2 * dt);
  state.s = Math.min(path.total, state.s + state.v * dt);
  if (state.phase === "run" && path.boxS - state.s < 0.15 && state.v < 0.6) {
    state.phase = "stopped";
    state.v = 0;
    state.stopLeft = stopSeconds;
  }
  if (state.phase === "leave" && state.s >= path.total - 0.05) state.done = true;
}

export interface PathPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/** The pose at arc position s (linear between points, yaw from the nearer one). */
export function samplePath(path: PitPath, s: number, out: PathPose = { x: 0, y: 0, z: 0, yaw: 0 }): PathPose {
  const last = path.cum.length - 1;
  const clamped = Math.min(path.total, Math.max(0, s));
  // Binary search for the segment.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path.cum[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const span = path.cum[hi] - path.cum[lo] || 1;
  const t = Math.min(1, Math.max(0, (clamped - path.cum[lo]) / span));
  out.x = path.xs[lo] + (path.xs[hi] - path.xs[lo]) * t;
  out.y = path.ys[lo] + (path.ys[hi] - path.ys[lo]) * t;
  out.z = path.zs[lo] + (path.zs[hi] - path.zs[lo]) * t;
  // Shortest-way blend of the two headings.
  let dy = path.yaws[hi] - path.yaws[lo];
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  out.yaw = path.yaws[lo] + dy * t;
  return out;
}
