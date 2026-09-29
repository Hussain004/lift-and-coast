// A drivable pit lane, generated from the centreline: the lane peels off the
// pit straight before the start line, runs alongside it, and merges back
// after. Pure geometry (no three.js) - app/race/PitLane.tsx draws it,
// trackLimits.ts treats it as road, Car.tsx applies the limiter and the box.
//
// Everything is an offset of the existing centreline, so there is no new
// data to author per track. A track whose pit straight has no room (another
// section of the lap runs alongside) gets `null` and keeps the old virtual
// pit window (see strategy.ts).
import type { TrackData } from "./types";
import { barrierProfileForTrack } from "./environment";

/** Half the lane's drivable width, metres (a 7 m lane). */
export const PIT_LANE_HALF_WIDTH = 3.5;
/** Pit-lane speed limit: 80 km/h. */
export const PIT_SPEED_LIMIT_MS = 80 / 3.6;
/** Centre-line clearance past the track edge on the straight part, metres. */
const STRAIGHT_GAP_METERS = 8;
/** Where the lane meets the track it sits 1 m inside the painted edge. */
const MERGE_GAP_METERS = -1;
const ENTRY_BEFORE_LINE_METERS = 280;
const EXIT_AFTER_LINE_METERS = 330;
const RAMP_IN_METERS = 100;
const RAMP_OUT_METERS = 110;
/** The player's box, past the start line. */
const BOX_AFTER_LINE_METERS = 170;
/** Half the length of the marked box the car must stop inside. */
export const PIT_BOX_HALF_LENGTH = 4;

export interface PitLane {
  /** +1 = lane on the driver's right of the direction of travel, -1 = left. */
  sign: 1 | -1;
  /** Centreline index the lane leaves the track at, and rejoins it at (may wrap past 0). */
  entryIndex: number;
  exitIndex: number;
  /** Number of centreline points the lane spans. */
  span: number;
  /** Lateral offset of the lane centre per centreline index (right +); NaN off the lane. */
  offsetByIndex: Float32Array;
  /** Metres past the painted edge of the lane centre, per index; NaN off the lane. */
  gapByIndex: Float32Array;
  /** Lane centre, world space, entry to exit. */
  points: [number, number, number][];
  /** Centreline index of each point in `points`. */
  indices: number[];
  /** Arc position of the lane's first and last full-width point, metres from the entry. */
  rampInMeters: number;
  rampOutStartMeters: number;
  lengthMeters: number;
  box: { index: number; x: number; y: number; z: number; headingRad: number };
}

function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

function build(track: TrackData, sign: 1 | -1): PitLane | null {
  const n = track.centerline.length;
  if (n < 50 || track.lengthMeters < 1500) return null;
  const spacing = track.lengthMeters / n;
  const entryIndex = ((n - Math.round(ENTRY_BEFORE_LINE_METERS / spacing)) % n + n) % n;
  const exitIndex = Math.round(EXIT_AFTER_LINE_METERS / spacing) % n;
  const span = Math.round((ENTRY_BEFORE_LINE_METERS + EXIT_AFTER_LINE_METERS) / spacing) + 1;
  const offsetByIndex = new Float32Array(n).fill(NaN);
  const gapByIndex = new Float32Array(n).fill(NaN);
  const points: [number, number, number][] = [];
  const indices: number[] = [];
  const total = (span - 1) * spacing;
  for (let k = 0; k < span; k++) {
    const i = (entryIndex + k) % n;
    const s = k * spacing;
    const inT = smoothstep(s / RAMP_IN_METERS);
    const outT = smoothstep((total - s) / RAMP_OUT_METERS);
    const gap = MERGE_GAP_METERS + (STRAIGHT_GAP_METERS - MERGE_GAP_METERS) * Math.min(inT, outT);
    const half = track.width[i] / 2;
    const offset = sign * (half + gap);
    offsetByIndex[i] = offset;
    gapByIndex[i] = gap;
    const before = track.centerline[(i - 1 + n) % n];
    const after = track.centerline[(i + 1) % n];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const len = Math.hypot(tx, tz) || 1;
    const rx = -tz / len;
    const rz = tx / len;
    const c = track.centerline[i];
    points.push([c[0] + rx * offset, c[1], c[2] + rz * offset]);
    indices.push(i);
  }
  const boxIndex = Math.round(BOX_AFTER_LINE_METERS / spacing) % n;
  const bp = points[indices.indexOf(boxIndex)];
  const bBefore = track.centerline[(boxIndex - 1 + n) % n];
  const bAfter = track.centerline[(boxIndex + 1) % n];
  const lane: PitLane = {
    sign,
    entryIndex,
    exitIndex,
    span,
    offsetByIndex,
    gapByIndex,
    points,
    indices,
    rampInMeters: RAMP_IN_METERS,
    rampOutStartMeters: total - RAMP_OUT_METERS,
    lengthMeters: total,
    box: {
      index: boxIndex,
      x: bp[0],
      y: bp[1],
      z: bp[2],
      headingRad: Math.atan2(-(bAfter[0] - bBefore[0]), -(bAfter[2] - bBefore[2])),
    },
  };
  return lane;
}

/** Whether another stretch of the lap runs close enough to the lane to make it unusable. */
function isClear(track: TrackData, lane: PitLane): boolean {
  const n = track.centerline.length;
  const inSpan = new Set(lane.indices);
  const guard = 60; // points either side of the lane that belong to the same straight
  const near = (i: number) => {
    for (const laneIndex of [lane.entryIndex, lane.exitIndex]) {
      const d = Math.abs(((i - laneIndex + n * 1.5) % n) - n * 0.5);
      if (d < guard) return true;
    }
    return inSpan.has(i);
  };
  const barrier = barrierProfileForTrack(track.id).setbackMeters;
  for (let k = 0; k < lane.points.length; k += 3) {
    const [px, , pz] = lane.points[k];
    for (let j = 0; j < n; j++) {
      if (near(j)) continue;
      const c = track.centerline[j];
      const d = Math.hypot(c[0] - px, c[2] - pz);
      if (d < track.width[j] / 2 + PIT_LANE_HALF_WIDTH + 3) return false;
    }
  }
  // The lane's outer edge must sit inside the barrier line.
  return STRAIGHT_GAP_METERS + PIT_LANE_HALF_WIDTH + 1.5 <= barrier;
}

/** Half-width of the timing gate that also takes in the lane (lapTimer.ts). */
export function pitGateHalfWidth(track: TrackData, base: number): number {
  return getPitLane(track) ? Math.max(base, track.width[0] / 2 + STRAIGHT_GAP_METERS + PIT_LANE_HALF_WIDTH + 0.5) : base;
}

/**
 * Where a car stands relative to the lane: whether it is on the lane proper
 * (past the painted edge, so the limiter applies) and how far the player's
 * box is ahead along the lane (negative once passed), or null off the lane.
 */
export function pitLaneStatus(
  track: TrackData,
  lane: PitLane,
  index: number,
  lateralMeters: number
): { inLane: boolean; boxAheadMeters: number | null } {
  if (!laneCovers(lane, index, lateralMeters)) return { inLane: false, boxAheadMeters: null };
  const n = track.centerline.length;
  const spacing = track.lengthMeters / n;
  const beyondEdge = lane.sign * lateralMeters - track.width[index] / 2;
  const delta = ((lane.box.index - index + n * 1.5) % n) - n * 0.5;
  return { inLane: beyondEdge > 1, boxAheadMeters: delta * spacing };
}

const cache = new WeakMap<TrackData, PitLane | null>();

/** The circuit's pit lane, or null when its pit straight has no room for one. */
export function getPitLane(track: TrackData): PitLane | null {
  if (cache.has(track)) return cache.get(track) ?? null;
  let lane: PitLane | null = null;
  for (const sign of [1, -1] as const) {
    const candidate = build(track, sign);
    if (candidate && isClear(track, candidate)) {
      lane = candidate;
      break;
    }
  }
  cache.set(track, lane);
  return lane;
}

/**
 * Is (centreline index, signed lateral offset) inside the lane's drivable
 * band? Called from checkTrackLimits for every wheel, so it is two array
 * reads and a compare.
 */
export function laneCovers(lane: PitLane, index: number, lateralMeters: number): boolean {
  const offset = lane.offsetByIndex[index];
  return offset === offset && Math.abs(lateralMeters - offset) <= PIT_LANE_HALF_WIDTH;
}
