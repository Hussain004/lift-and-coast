/** Finish-line gate half-width used by both cars (Car.tsx, AICar.tsx). */
export const LINE_HALF_WIDTH_METERS = 6;

export interface LapTimerConfig {
  startPos: { x: number; z: number; headingRad: number };
  /** Half-width of the finish line gate, in meters. */
  lineHalfWidth: number;
  /**
   * The car spawns behind the line (a staggered grid spot): the first
   * crossing starts the clock instead of ending a lap, so the run up to
   * the line doesn't record a bogus ~2s "lap" (and best-lap, ghost
   * reference and qualifying comparisons stay clean). Exactly one crossing
   * is forgiven; everything after behaves normally.
   */
  startsBehindLine?: boolean;
}

export interface LapTimerState {
  currentLapSeconds: number;
  lapCount: number;
  lastLapSeconds: number | null;
  bestLapSeconds: number | null;
  crossedFinishLine: boolean;
}

/**
 * Detects finish-line crossings by projecting the car's position onto the
 * track's forward/right axes at the start point, and counts laps/timing off
 * that. A crossing only counts once the car has actually been some distance
 * behind the line (BEHIND_DEADZONE_METERS) - without that, the tiny
 * spawn-frame jitter around position (0,0) relative to the line would
 * register as an instant, bogus lap.
 *
 * Verified against the real Silverstone centerline (2946 points): no other
 * point on the lap comes within 20m laterally of the start line's axis
 * while also sitting near zero on the forward axis, so a straightforward
 * projection check (rather than true finite-segment intersection) is safe
 * here - revisit if a future track's layout loops back near its own start.
 */
export function createLapTimer(config: LapTimerConfig) {
  const BEHIND_DEADZONE_METERS = 3;
  const forward = {
    x: -Math.sin(config.startPos.headingRad),
    z: -Math.cos(config.startPos.headingRad),
  };
  const right = { x: -forward.z, z: forward.x };

  let prevSignedForward: number | null = null;
  let armed = false;
  let skipFirstCrossing = config.startsBehindLine ?? false;
  let currentLapSeconds = 0;
  let lapCount = 0;
  let lastLapSeconds: number | null = null;
  let bestLapSeconds: number | null = null;

  function update(position: { x: number; z: number }, dt: number): LapTimerState {
    const dx = position.x - config.startPos.x;
    const dz = position.z - config.startPos.z;
    const signedForward = dx * forward.x + dz * forward.z;
    const lateral = dx * right.x + dz * right.z;

    if (signedForward < -BEHIND_DEADZONE_METERS) armed = true;

    let crossedFinishLine = false;
    if (
      armed &&
      prevSignedForward !== null &&
      prevSignedForward < 0 &&
      signedForward >= 0 &&
      Math.abs(lateral) < config.lineHalfWidth
    ) {
      if (skipFirstCrossing) {
        // Grid-spot start: the clock starts here, nothing is recorded.
        skipFirstCrossing = false;
        armed = false;
        currentLapSeconds = 0;
      } else {
        crossedFinishLine = true;
        armed = false;
        lapCount += 1;
        lastLapSeconds = currentLapSeconds;
        if (bestLapSeconds === null || currentLapSeconds < bestLapSeconds) {
          bestLapSeconds = currentLapSeconds;
        }
        currentLapSeconds = 0;
      }
    }

    currentLapSeconds += dt;
    prevSignedForward = signedForward;

    return { currentLapSeconds, lapCount, lastLapSeconds, bestLapSeconds, crossedFinishLine };
  }

  /**
   * Rolls the current lap's elapsed time back by `seconds` - call once when
   * the rewind mechanic (Car.tsx) finishes, with however much time it
   * actually scrubbed back, so a rewound mistake doesn't leave the lap
   * clock still counting the time spent making (and undoing) it. Clamped
   * at 0 rather than going negative - a rewind spanning back across the
   * previous lap's finish-line crossing isn't unwound here (lap count and
   * the previous lap's recorded result are untouched), just floored.
   * Returns the resulting currentLapSeconds, so a caller can tell whether
   * the rollback reached back past some earlier point in the lap (e.g.
   * Car.tsx comparing it against when a track-limits violation happened).
   */
  function rewindBy(seconds: number): number {
    currentLapSeconds = Math.max(0, currentLapSeconds - seconds);
    return currentLapSeconds;
  }

  return { update, rewindBy };
}

export function formatLapTime(seconds: number | null): string {
  if (seconds === null) return "--:--.---";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}
