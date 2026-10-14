// A whole-race recording for the post-race replay: every car's pose, sampled
// at 10 Hz into chunked Float32 storage (7 floats a car a sample: position and
// quaternion), plus a short list of notable moments. Playback interpolates
// between samples, so 10 Hz is invisible. 20 cars is ~5.6 KB/s, ~10 MB for a
// 30-minute race, and chunks are allocated as the race goes on, so a short
// race costs almost nothing.

export const RECORD_HZ = 10;
const STRIDE = 7;
const CHUNK_SAMPLES = 600; // 60 s

export type RaceEventKind = "start" | "pass" | "contact" | "fastest" | "finish";

export interface RaceEvent {
  /** Race-clock seconds. */
  t: number;
  kind: RaceEventKind;
  /** The car the moment is about (0 = the player). */
  car: number;
  label: string;
}

export interface Pose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export function createPose(): Pose {
  return { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1 };
}

export interface RaceRecorder {
  readonly cars: number;
  events: RaceEvent[];
  /** Moves the write cursor to the sample for this race-clock time (never backwards). */
  advance(clockSeconds: number): void;
  /** Stores a car's pose in the current sample; the last write in a sample wins. */
  write(car: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
  addEvent(event: RaceEvent): void;
  /** Seconds recorded so far. */
  duration(): number;
  /** The car's interpolated pose at `t`, clamped to what was recorded. False if nothing is recorded. */
  poseAt(car: number, t: number, out: Pose): boolean;
}

export function createRaceRecorder(cars: number): RaceRecorder {
  const chunks: Float32Array[] = [];
  let cursor = 0;
  const events: RaceEvent[] = [];

  function slot(sample: number): { chunk: Float32Array; base: number } {
    const c = Math.floor(sample / CHUNK_SAMPLES);
    while (chunks.length <= c) chunks.push(new Float32Array(CHUNK_SAMPLES * cars * STRIDE));
    return { chunk: chunks[c], base: (sample % CHUNK_SAMPLES) * cars * STRIDE };
  }

  slot(0);

  return {
    cars,
    events,
    advance(clockSeconds) {
      const target = Math.floor(Math.max(0, clockSeconds) * RECORD_HZ);
      if (target <= cursor) return;
      // Carry the last poses forward so a car that does not write this sample
      // (a retired or paused car) holds still rather than snapping to zero.
      const prev = slot(cursor);
      const prevCopy = prev.chunk.slice(prev.base, prev.base + cars * STRIDE);
      for (let s = cursor + 1; s <= target; s++) {
        const next = slot(s);
        next.chunk.set(prevCopy, next.base);
      }
      cursor = target;
    },
    write(car, x, y, z, qx, qy, qz, qw) {
      const { chunk, base } = slot(cursor);
      const o = base + car * STRIDE;
      chunk[o] = x;
      chunk[o + 1] = y;
      chunk[o + 2] = z;
      chunk[o + 3] = qx;
      chunk[o + 4] = qy;
      chunk[o + 5] = qz;
      chunk[o + 6] = qw;
    },
    addEvent(event) {
      events.push(event);
    },
    duration() {
      return cursor / RECORD_HZ;
    },
    poseAt(car, t, out) {
      if (car < 0 || car >= cars) return false;
      const f = Math.min(cursor, Math.max(0, t * RECORD_HZ));
      const i = Math.floor(f);
      const j = Math.min(cursor, i + 1);
      const a = slot(i);
      const b = slot(j);
      const oa = a.base + car * STRIDE;
      const ob = b.base + car * STRIDE;
      const k = f - i;
      out.x = a.chunk[oa] + (b.chunk[ob] - a.chunk[oa]) * k;
      out.y = a.chunk[oa + 1] + (b.chunk[ob + 1] - a.chunk[oa + 1]) * k;
      out.z = a.chunk[oa + 2] + (b.chunk[ob + 2] - a.chunk[oa + 2]) * k;
      // Quaternions between neighbouring samples are close, so a normalised
      // lerp (taking the short way round) is indistinguishable from slerp.
      const dot =
        a.chunk[oa + 3] * b.chunk[ob + 3] +
        a.chunk[oa + 4] * b.chunk[ob + 4] +
        a.chunk[oa + 5] * b.chunk[ob + 5] +
        a.chunk[oa + 6] * b.chunk[ob + 6];
      const s = dot < 0 ? -1 : 1;
      let qx = a.chunk[oa + 3] + (s * b.chunk[ob + 3] - a.chunk[oa + 3]) * k;
      let qy = a.chunk[oa + 4] + (s * b.chunk[ob + 4] - a.chunk[oa + 4]) * k;
      let qz = a.chunk[oa + 5] + (s * b.chunk[ob + 5] - a.chunk[oa + 5]) * k;
      let qw = a.chunk[oa + 6] + (s * b.chunk[ob + 6] - a.chunk[oa + 6]) * k;
      const len = Math.hypot(qx, qy, qz, qw) || 1;
      qx /= len;
      qy /= len;
      qz /= len;
      qw /= len;
      out.qx = qx;
      out.qy = qy;
      out.qz = qz;
      out.qw = qw;
      return true;
    },
  };
}

// ---- notable moments ----

/** A new position must hold this long before it counts as a pass. */
export const PASS_HOLD_SECONDS = 2;
/** Ignore the opening scramble: the start is its own clip. */
export const PASS_IGNORE_SECONDS = 8;

export interface PassTracker {
  settled: number;
  pending: number;
  pendingSince: number;
}

export function createPassTracker(): PassTracker {
  return { settled: 0, pending: 0, pendingSince: 0 };
}

/**
 * Feeds the player's live position. Returns an event when they have gained a
 * place and held it for PASS_HOLD_SECONDS, dated to when they first got it.
 * Losing a place just resets the baseline, so a car that re-passes straight
 * back, or a rival pitting, never reads as a brilliant move.
 */
export function updatePassTracker(tracker: PassTracker, position: number, clock: number): RaceEvent | null {
  if (clock < PASS_IGNORE_SECONDS || position <= 0) {
    tracker.settled = position;
    tracker.pending = position;
    tracker.pendingSince = clock;
    return null;
  }
  if (tracker.settled === 0 || position > tracker.settled) {
    tracker.settled = position;
    tracker.pending = position;
    tracker.pendingSince = clock;
    return null;
  }
  if (position !== tracker.pending) {
    tracker.pending = position;
    tracker.pendingSince = clock;
    return null;
  }
  if (position < tracker.settled && clock - tracker.pendingSince >= PASS_HOLD_SECONDS) {
    const gained = tracker.settled - position;
    tracker.settled = position;
    return {
      t: tracker.pendingSince,
      kind: "pass",
      car: 0,
      label: gained > 1 ? `UP TO P${position}` : `OVERTAKE · P${position}`,
    };
  }
  return null;
}

export interface Clip {
  from: number;
  to: number;
  label: string;
  car: number;
}

const CLIP_BEFORE = 3;
const CLIP_AFTER = 4;
const START_CLIP_SECONDS = 9;

/**
 * Turns the event list into non-overlapping clips, in time order. Each event
 * gets a few seconds either side; overlapping ones merge under the first
 * label so a scramble is one clip, not five.
 */
export function pickClips(events: readonly RaceEvent[], durationSeconds: number): Clip[] {
  const raw: Clip[] = events.map((e) =>
    e.kind === "start"
      ? { from: 0, to: Math.min(durationSeconds, START_CLIP_SECONDS), label: e.label, car: e.car }
      : {
          from: Math.max(0, e.t - CLIP_BEFORE),
          to: Math.min(durationSeconds, e.t + CLIP_AFTER),
          label: e.label,
          car: e.car,
        }
  );
  raw.sort((a, b) => a.from - b.from);
  const out: Clip[] = [];
  for (const c of raw) {
    if (c.to <= c.from) continue;
    const last = out[out.length - 1];
    if (last && c.from <= last.to) last.to = Math.max(last.to, c.to);
    else out.push({ ...c });
  }
  return out;
}
