import type { TrackData } from "./types";
import type { RacingLinePoint, RacingLineProfile } from "./racingLine";
import { computeRacingLine } from "./racingLine";

// computeRacingLine is an O(n) two-pass optimization over 1,700-3,000
// centerline points, and its output depends only on the track geometry and
// requested profile. Before this cache, every AICar instance computed it on
// mount (plus one more in Track.tsx for the visible ribbon) - 21 identical
// computations per race load. The line arrays are shared read-only: no
// consumer mutates points (they write derived values into their own buffers),
// so one instance per profile serves the whole scene.
const racingLineCache = new WeakMap<
  TrackData,
  Partial<Record<RacingLineProfile, RacingLinePoint[]>>
>();

/**
 * The (shared, read-only) ideal racing line for a track and profile, computed
 * on first request and reused by every matching AICar, Track ribbon and test
 * thereafter. Semantically identical to calling computeRacingLine directly -
 * same pure function underneath - just computed once per track/profile pair.
 */
export function getRacingLine(
  track: TrackData,
  profile: RacingLineProfile = "default"
): RacingLinePoint[] {
  let profiles = racingLineCache.get(track);
  if (!profiles) {
    profiles = {};
    racingLineCache.set(track, profiles);
  }
  let line = profiles[profile];
  if (!line) {
    line = computeRacingLine(track, profile);
    profiles[profile] = line;
  }
  return line;
}

/**
 * Per racing-line point: how far the car's centre can move off the line
 * toward each track edge (in the steering's line frame - "plus" is the
 * side pathFollower's positive lateral offset moves toward), and which
 * side is the inside of the next real corner (+1, -1, or 0 on a flat-out
 * run). This is what racecraft needs to go side by side without driving
 * off the road or into the car next to it.
 */
export interface LineRoom {
  plus: Float32Array;
  minus: Float32Array;
  cornerSign: Int8Array;
}

/** Car centre to the painted edge: half the car plus a wheel's width. */
const EDGE_MARGIN_METERS = 1.3;
/** Profile targets at/above this are flat out - not a corner. */
const CORNER_SPEED_CEILING_MS = 66;
const CORNER_SEARCH_METERS = 400;

export function computeLineRoom(track: TrackData, line: RacingLinePoint[]): LineRoom {
  const n = line.length;
  const plus = new Float32Array(n);
  const minus = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const prev = track.centerline[(i - 1 + n) % n];
    const next = track.centerline[(i + 1) % n];
    const tx = next[0] - prev[0];
    const tz = next[2] - prev[2];
    const len = Math.hypot(tx, tz) || 1;
    // Same (-z, x) perpendicular the racing line builder and the pursuit
    // offset both use.
    const rx = -tz / len;
    const rz = tx / len;
    const c = track.centerline[i];
    const p = line[i].position;
    const s = (p[0] - c[0]) * rx + (p[2] - c[2]) * rz;
    const half = track.width[i] / 2;
    plus[i] = Math.max(0, half - s - EDGE_MARGIN_METERS);
    minus[i] = Math.max(0, half + s - EDGE_MARGIN_METERS);
  }
  // Inside of each corner: the sign of the line's turn around each local
  // minimum of the speed profile, then carried backward so every point
  // knows the next corner within CORNER_SEARCH_METERS.
  const turnSignAt = (j: number): -1 | 0 | 1 => {
    const a = line[(j - 10 + n) % n].position;
    const b = line[(j - 9 + n) % n].position;
    const c = line[(j + 9) % n].position;
    const d = line[(j + 10) % n].position;
    const cross = (b[0] - a[0]) * (d[2] - c[2]) - (b[2] - a[2]) * (d[0] - c[0]);
    return cross > 1e-3 ? 1 : cross < -1e-3 ? -1 : 0;
  };
  const cornerSign = new Int8Array(n);
  let carried: -1 | 0 | 1 = 0;
  let carriedDistance = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      const t = line[k].targetSpeedMs;
      const isCorner =
        t < CORNER_SPEED_CEILING_MS &&
        t < line[(k - 1 + n) % n].targetSpeedMs &&
        t <= line[(k + 1) % n].targetSpeedMs;
      if (isCorner) {
        carried = turnSignAt(k);
        carriedDistance = 0;
      } else {
        carriedDistance += line[k].distanceToNextMeters;
      }
      cornerSign[k] = carriedDistance <= CORNER_SEARCH_METERS ? carried : 0;
    }
  }
  return { plus, minus, cornerSign };
}

const lineRoomCache = new WeakMap<
  TrackData,
  Partial<Record<RacingLineProfile, LineRoom>>
>();

export function getLineRoom(
  track: TrackData,
  profile: RacingLineProfile = "default"
): LineRoom {
  let profiles = lineRoomCache.get(track);
  if (!profiles) {
    profiles = {};
    lineRoomCache.set(track, profiles);
  }
  let room = profiles[profile];
  if (!room) {
    room = computeLineRoom(track, getRacingLine(track, profile));
    profiles[profile] = room;
  }
  return room;
}
