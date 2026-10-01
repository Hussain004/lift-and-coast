// Turning a ghost into something you can be timed against (roadmap 11.9:
// "delta to the chosen ghost, sector comparisons against it").
//
// The obstacle is that the two things being compared are indexed
// differently. The delta timer (see deltaTimer.ts) looks up its reference by
// PROGRESS along the centerline - "how far ahead was the reference when it was
// here" - because that is the number a driver can act on. A ghost, though, is
// a list of world POSITIONS stamped with time. It has no progress axis at
// all. So a downloaded rival ghost cannot be handed to the delta timer
// directly; it has to be projected onto the centerline first.
//
// This module is that projection, plus the sector split that falls out of it.
// It reuses trackProgress (see progressTracker.ts) rather than a fresh
// nearest-point search, which is the important part: that function is
// continuity-aware, and a lap crosses the start/finish seam where indices 0
// and n-1 sit metres apart in space. A naive nearest-point projection flips a
// ghost from 99% of the lap to 1% every time it crosses the line, which would
// make the delta bar spike once a lap for no reason the player did anything.

import type { TrackData } from "../tracks/types";
import { trackProgress, type ProgressTracker } from "./progressTracker";
import type { GhostSample } from "./ghostRecorder";

/** A ghost resampled onto the progress axis, for time lookups. */
export interface GhostProgressTrace {
  /**
   * Monotonically non-decreasing progress in metres, UNWRAPPED across the
   * start/finish line and normalised so the first sample is 0. This is "how
   * far this ghost has travelled this lap", which is a strictly increasing
   * axis and safe to interpolate along.
   */
  progressMeters: number[];
  /** The time the ghost reached each progress value, seconds. */
  elapsedSeconds: number[];
  /** The ghost's own lap time, seconds. */
  lapSeconds: number;
  /** The circuit this was projected against, for the travel check. */
  trackLengthMeters: number;
}

/**
 * Projects a ghost's positions onto the centerline.
 *
 * Returns null for a trace too short to project - three samples is not a lap,
 * and a degenerate projection would produce a delta that reads as plausible
 * and is meaningless, which is worse than no delta at all.
 *
 * THE SEAM. trackProgress returns (index / n) * length, which genuinely WRAPS:
 * a car crossing the line goes from index 63/64 to index 0/64, so its progress
 * jumps from 984m to 0m. That is fine for a live tower, where every car wraps
 * in the same place and the wrap is meaningful ("back to the start"). It is
 * NOT fine for a per-lap trace, where the whole point is a monotonically
 * increasing axis to interpolate along - left wrapped, the delta bar spikes
 * once a lap for no reason the player did anything.
 *
 * So the wrap is UNWRAPPED here: a backward jump larger than half the circuit
 * is a seam crossing, not a reversal, and each one adds a lap to the running
 * offset. The trace is then normalised to start at zero, so its travel is
 * exactly "distance covered this lap" - which is also precisely what the
 * upload guard's travel check measures (see ghostUploadGuard), so the two
 * cannot disagree about what one lap of travel means.
 */
export function projectGhostToProgress(
  track: TrackData,
  samples: readonly GhostSample[],
  lapSeconds: number
): GhostProgressTrace | null {
  if (samples.length < 3 || !Number.isFinite(lapSeconds) || lapSeconds <= 0) return null;
  const n = track.centerline.length;
  if (n === 0) return null;

  const raw: number[] = [];
  const elapsedSeconds: number[] = [];
  // One tracker for the whole lap, seeded by the first sample: the ghost's
  // index is continuous by construction, so a single tracker follows it round
  // the circuit without ever falling back to a global rescan.
  const tracker: ProgressTracker = { index: null };
  let previousIndex: number | null = null;
  let lapOffset = 0;

  for (const s of samples) {
    const { progressMeters: p, nearestIndex } = trackProgress(
      track,
      s.position.x,
      s.position.z,
      tracker,
      s.position.y
    );
    if (previousIndex !== null) {
      // A backward step of more than half the circuit is a line crossing. Any
      // smaller backward step is the car genuinely reversing or spinning, and
      // is left alone so a real reversal still shows up in the trace.
      if (previousIndex - nearestIndex > n / 2) lapOffset += track.lengthMeters;
    }
    raw.push(p + lapOffset);
    elapsedSeconds.push(s.elapsedSeconds);
    previousIndex = nearestIndex;
  }

  // Normalise to start at the ghost's own first projected point, so travel is
  // measured from where the lap actually began rather than from the line.
  const start = raw[0];
  const progressMeters = raw.map((p) => p - start);

  return { progressMeters, elapsedSeconds, lapSeconds, trackLengthMeters: track.lengthMeters };
}

/**
 * The ghost's time at a given progress along the track, or null if it has not
 * reached that point yet.
 *
 * Linear between the two samples straddling the distance, matching
 * deltaTimer's contract, so a delta computed here and one computed by the
 * built-in tracker against the same reference agree.
 *
 * `null` before the ghost's first sample is deliberate: a delta needs both
 * cars to be on the same part of the track, and reporting "you are 40 seconds
 * up" at the line because the reference has not moved yet is a lie.
 */
export function ghostTimeAt(trace: GhostProgressTrace, progressMeters: number): number | null {
  const n = trace.progressMeters.length;
  if (n < 2) return null;
  const first = trace.progressMeters[0];
  const last = trace.progressMeters[n - 1];
  if (progressMeters <= first) return trace.elapsedSeconds[0];
  if (progressMeters >= last) return trace.elapsedSeconds[n - 1];

  for (let i = 1; i < n; i += 1) {
    const a = trace.progressMeters[i - 1];
    const b = trace.progressMeters[i];
    if (progressMeters <= b) {
      const span = b - a;
      const t = span <= 0 ? 0 : (progressMeters - a) / span;
      return trace.elapsedSeconds[i - 1] + t * (trace.elapsedSeconds[i] - trace.elapsedSeconds[i - 1]);
    }
  }
  return trace.elapsedSeconds[n - 1];
}

/**
 * Live delta in seconds: positive means the player is BEHIND the ghost, which
 * is the sign the HUD's green/red colouring expects. Returns null until the
 * player and the ghost are both on the same part of the track.
 */
export function deltaToGhost(
  trace: GhostProgressTrace,
  playerProgressMeters: number,
  playerElapsedSeconds: number
): number | null {
  const referenceTime = ghostTimeAt(trace, playerProgressMeters);
  if (referenceTime === null) return null;
  return playerElapsedSeconds - referenceTime;
}

export interface GhostSectorSplit {
  /** Cumulative split time at the end of each sector, seconds. */
  cumulativeSeconds: number[];
  /** Each sector's own duration, seconds. */
  sectorSeconds: number[];
}

/**
 * The ghost's sector splits, read off the progress trace at the sector gates.
 *
 * CUMULATIVE, which is how the lap timer reports them and therefore what the
 * guard's monotonicity check expects (see ghostUploadGuard). Returns null if
 * the gates do not increase, rather than emitting a nonsensical split - a
 * sector boundary at 0m would otherwise produce a negative first sector.
 */
export function ghostSectorSplit(
  track: TrackData,
  trace: GhostProgressTrace,
  sectorCount: number,
  sectorBoundaries: number[]
): GhostSectorSplit | null {
  if (sectorCount < 1 || sectorBoundaries.length < sectorCount) return null;
  const cumulativeSeconds: number[] = [];
  for (let i = 0; i < sectorCount; i += 1) {
    const boundary = sectorBoundaries[i];
    if (!(boundary > 0) || boundary > track.lengthMeters) return null;
    const t = ghostTimeAt(trace, boundary);
    if (t === null) return null;
    cumulativeSeconds.push(t);
  }
  const sectorSeconds: number[] = [];
  let previous = 0;
  for (const c of cumulativeSeconds) {
    if (c <= previous) return null;
    sectorSeconds.push(c - previous);
    previous = c;
  }
  return { cumulativeSeconds, sectorSeconds };
}
