export interface DeltaSample {
  progressMeters: number;
  elapsedSeconds: number;
}

/**
 * Live delta-to-best-lap timer (plan section 13: "the cheapest feature that
 * makes driving feel skill-based and trackable"). Records (progress, time)
 * samples through the current lap; once a lap completes, the fastest lap's
 * recording becomes the reference other laps compare against by looking up
 * the reference's time at the same track progress, not the same wall-clock
 * moment - so the delta reflects "ahead/behind at this point on track", not
 * just "ahead/behind right now".
 *
 * Session-local only (not persisted) - a saved best lap from a previous
 * visit has no recorded per-point telemetry to compare against, only the
 * single best-lap-time float in localStorage (see bestLapStorageKey in
 * Car.tsx). Reference resets each page load; delta only appears after the
 * player's own first completed lap in the current session.
 */
// A lap this long (~5.5 minutes at 60fps) will never be a real best time,
// so recording is stopped rather than left unbounded for a session where
// the player never crosses the line (idling, or a long off-track wander -
// the off-track teleport reset doesn't itself end a lap). `wasOverlong`
// additionally blocks promotion even in the one case a long lap COULD
// still look like a "new best" - the player's very first lap ever, before
// bestLapRef has any value to compare against.
export const MAX_RECORDING_SAMPLES = 20000;

export function createDeltaTracker() {
  let recording: DeltaSample[] = [];
  let reference: DeltaSample[] | null = null;
  let wasOverlong = false;

  /** Call once per frame while driving, with the current lap's progress/time. */
  function recordSample(progressMeters: number, elapsedSeconds: number): number | null {
    if (recording.length < MAX_RECORDING_SAMPLES) {
      recording.push({ progressMeters, elapsedSeconds });
    } else {
      wasOverlong = true;
    }
    if (!reference || reference.length < 2) return null;
    return elapsedSeconds - referenceTimeAt(reference, progressMeters);
  }

  /**
   * Call once on the frame a lap completes, before that frame's
   * `recordSample` call for the new lap. Appends a synthetic closing sample
   * at the track's exact length (not the current frame's nearest-centerline
   * progress reading, which can undershoot the true finish line by up to
   * half a centerline segment) paired with the lap's authoritative final
   * time, so the reference's tail interpolates correctly right up to the
   * line - recordSample alone would otherwise pair the finished lap's
   * end-of-track progress with the new lap's near-zero elapsed time on this
   * same frame, corrupting exactly the samples a close finish needs most.
   */
  function endLap(lapSeconds: number, trackLengthMeters: number, wasNewBest: boolean) {
    if (recording.length < MAX_RECORDING_SAMPLES) {
      recording.push({ progressMeters: trackLengthMeters, elapsedSeconds: lapSeconds });
    }
    if (wasNewBest && !wasOverlong) reference = recording;
    recording = [];
    wasOverlong = false;
  }

  return { recordSample, endLap };
}

/**
 * Linear interpolation between the two reference samples straddling
 * `progressMeters`. Reference samples are recorded in driving order, so
 * this is a linear scan rather than a binary search - a lap's worth of
 * samples (a few thousand at 60fps) is cheap to scan once per frame.
 */
function referenceTimeAt(reference: DeltaSample[], progressMeters: number): number {
  const first = reference[0];
  if (progressMeters <= first.progressMeters) return first.elapsedSeconds;
  const last = reference[reference.length - 1];
  if (progressMeters >= last.progressMeters) return last.elapsedSeconds;

  for (let i = 1; i < reference.length; i++) {
    const a = reference[i - 1];
    const b = reference[i];
    if (progressMeters <= b.progressMeters) {
      const span = b.progressMeters - a.progressMeters;
      const t = span <= 0 ? 0 : (progressMeters - a.progressMeters) / span;
      return a.elapsedSeconds + t * (b.elapsedSeconds - a.elapsedSeconds);
    }
  }
  return last.elapsedSeconds;
}

export function formatDelta(seconds: number | null): string {
  if (seconds === null) return "";
  const sign = seconds > 0 ? "+" : seconds < 0 ? "-" : "";
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}
