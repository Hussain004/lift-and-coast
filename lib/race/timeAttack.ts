/**
 * The landing-page time attack's lap logic, PURE and DOM-free.
 *
 * Everything that can be wrong about a lap time is decided here, so it can be
 * unit-tested without a browser, a physics engine or a network: when a lap
 * has actually been completed, whether it counts, whether it is a personal
 * best, and whether it is allowed to reach the leaderboard. The UI
 * (app/TimeAttack.tsx) owns the canvas and the keyboard, and the physics is
 * the shared car (lib/ai/driveSession.ts). Neither may re-derive any of the
 * rules below, or the two would drift - and a leaderboard whose validation
 * lives in two places is a leaderboard that eventually accepts anything.
 *
 * WHY LAP DETECTION IS NOT "PROGRESS WENT DOWN"
 *
 * `progressMeters` WRAPS at the start line, so a forward crossing is a big
 * backwards JUMP in progress, not a decrease. Worse, it is not a reliable
 * signal on its own: `checkTrackLimits` does a global nearest-centerline scan,
 * and at the seam the first and last centerline points are metres apart in
 * space, so a car sitting still ON the start line reads progress ~0 on one tick
 * and progress ~trackLength on the next. That flicker is documented at length
 * in lib/race/progressTracker.ts, which exists to stop exactly this for the
 * race tower.
 *
 * A stationary car at the line must therefore never bank a lap - and neither
 * must a car that has merely shuffled back and forth across it. Three
 * independent guards, because each covers a gap the others leave:
 *
 *   1. WRAP DETECTION, not a directional comparison. A crossing is a step
 *      larger than half the lap in either direction, which no amount of
 *      ordinary driving produces in a single 1/60 tick. The sign then says
 *      which way the car went over the line. (Reversing over the line is
 *      explicitly NOT a lap and must not count as covering the lap either.)
 *   2. DISTANCE COVERED. Before a wrap can complete a lap, the car must have
 *      accumulated at least HALF the lap's length in forward motion since the
 *      last reset. This is what makes the seam flicker harmless, and it is
 *      measured in distance travelled rather than in "have we been past the
 *      halfway point", because a positional flag is fooled by exactly the
 *      flicker we are defending against: a car parked on the line reads
 *      trackLength, which is past halfway, and would arm itself. Accumulated
 *      forward metres cannot be produced by flicker - near the seam the
 *      flicker moves progress by whole track lengths, and a step that large
 *      is a WRAP, which is excluded from the accumulator, so a parked car
 *      banks roughly a metre. Getting to halfway means genuinely covering
 *      halfway.
 *   3. MINIMUM LAP TIME, reused from the race's own lap timer
 *      (MIN_LAP_SECONDS) rather than reinvented. No circuit in the roster is
 *      lapped in under 20 seconds.
 *
 * A fourth case needs no guard at all, only correct bookkeeping: the session's
 * off-track backstop teleports the car to the grid and zeroes its clock, which
 * shows up here as the clock running BACKWARDS. That abandons the running lap
 * without scoring it - and the lap that starts from the grid afterwards is a
 * fresh one, not a penalised one.
 *
 * The clock is the SESSION's simulated elapsed time, not wall-clock, so a lap
 * is timed on the same fixed 1/60 ticks the physics actually ran and cannot be
 * made faster or slower by how the browser happened to slice its frames -
 * the same property driveSession's elapsed-time clamp exists to protect.
 */

import { isQualifyingLapValid } from "./qualifying";
import { MIN_LAP_SECONDS } from "./lapTimer";

/**
 * One frame of driving, as the lap logic needs to see it. Deliberately the
 * smallest useful surface: what the rules below depend on, and nothing about
 * physics, the DOM or the leaderboard.
 */
export interface TimeAttackFrame {
  /**
   * Arc-length progress along the lap, wrapping at the start line. Not
   * monotonic, and NOT safe to compare as an absolute - see the file comment.
   */
  progressMeters: number;
  /**
   * All four wheels past the ribbon edge. This is the game's own track-limits
   * rule (see allWheelsOffTrack and Car.tsx's live warning), NOT the merely
   * wide chassis-centre reading: a single tyre still touching keeps the lap
   * legal, so a wide corner exit is never punished. The caller computes it.
   */
  wheelsOffTrack: boolean;
  /** Simulated seconds since the session spawned or last reset. */
  elapsedSeconds: number;
}

/** A lap that reached the line, valid or not. */
export interface CompletedLap {
  /** Simulated seconds for the lap. */
  lapSeconds: number;
  /** False if the car put a wheel off, or the clock was discontinuous. */
  valid: boolean;
  /** True when this lap beat the session's previous best VALID lap. */
  isBest: boolean;
}

export interface TimeAttackState {
  /** Simulated seconds into the running lap. */
  currentLapSeconds: number;
  lapsCompleted: number;
  lastLapSeconds: number | null;
  /** Only meaningful alongside lastLapSeconds. */
  lastLapValid: boolean;
  /**
   * Best VALID lap this session, or null. An invalid lap never becomes the
   * best, so a ruined lap cannot raise the bar the next lap has to clear - and
   * can never be submitted.
   */
  bestLapSeconds: number | null;
  /** The running lap has already been ruined; shown as a live warning. */
  invalid: boolean;
  /** Set on the single frame a lap completes, null on every other frame. */
  completed: CompletedLap | null;
}

export interface TimeAttack {
  /**
   * Feed one frame, in order, and read the resulting state. The returned
   * `completed` is the UI's hook: a completed lap is the ONLY thing that may
   * end a lap, set a personal best or trigger a submission.
   */
  sample(frame: TimeAttackFrame): TimeAttackState;
  /** The state as of the last sample. */
  state(): TimeAttackState;
  /**
   * Back to the grid: the running lap is abandoned, but the session's lap
   * count, last lap and best lap all survive - chasing a personal best is the
   * entire point, and wiping it on every reset would leave the delta timer
   * with nothing to compare against. Call with the session's elapsed time
   * AFTER resetting it, so the clock reads as continuous.
   */
  reset(elapsedSeconds: number): TimeAttackState;
}

export function createTimeAttack(trackLengthMeters: number): TimeAttack {
  // A non-positive or non-finite length would make every threshold below
  // meaningless. Falling back to 0 means no distance can ever be covered, so
  // the tracker reports no laps at all rather than nonsense ones.
  const half = Number.isFinite(trackLengthMeters) && trackLengthMeters > 0
    ? trackLengthMeters / 2
    : 0;

  let lapStartElapsed = 0;
  let previousElapsed = 0;
  let previousProgress = 0;
  let started = false;
  /** Forward metres covered since the lap began; wraps contribute nothing. */
  let coveredMeters = 0;
  let trackLimitsInvalid = false;
  let lapsCompleted = 0;
  let lastLapSeconds: number | null = null;
  let lastLapValid = false;
  let bestLapSeconds: number | null = null;
  let completed: CompletedLap | null = null;

  function snapshot(): TimeAttackState {
    return {
      currentLapSeconds: previousElapsed - lapStartElapsed,
      lapsCompleted,
      lastLapSeconds,
      lastLapValid,
      bestLapSeconds,
      invalid: trackLimitsInvalid,
      completed,
    };
  }

  /** Throws the running lap away and starts a fresh one from here. */
  function abandon(elapsedSeconds: number, progressMeters: number): void {
    lapStartElapsed = elapsedSeconds;
    previousElapsed = elapsedSeconds;
    previousProgress = progressMeters;
    started = true;
    coveredMeters = 0;
    trackLimitsInvalid = false;
    completed = null;
  }

  function sample(frame: TimeAttackFrame): TimeAttackState {
    completed = null;
    const { progressMeters, wheelsOffTrack, elapsedSeconds } = frame;

    // The session's simulated clock runs backwards only when it teleports the
    // car back to the grid (OFF_TRACK_RESET_METERS - the same backstop Car.tsx
    // and simulateDrive use). That abandons the running lap outright: the lap
    // the car was on is not scored at all, and the lap that starts from the
    // grid afterwards is a genuinely fresh one, so it is NOT flagged invalid -
    // punishing the driver for the next lap would be inventing a penalty the
    // game does not have. Resynchronising progress here is also what stops a
    // teleport from 58% of the lap back to the line being read as a wrap.
    if (elapsedSeconds < previousElapsed) {
      abandon(elapsedSeconds, progressMeters);
      return snapshot();
    }

    const step = progressMeters - previousProgress;
    const wrappedForward = step < -half;
    const wrappedBackward = step > half;

    // The first frame only establishes a baseline: there is no previous
    // reading to diff against, and treating the spawn's own progress as
    // forward motion would start the lap's distance at whatever the car
    // happened to be doing. The off-track reading is still latched here, or a
    // car that spawned off the ribbon would get a free lap.
    if (!started) {
      abandon(elapsedSeconds, progressMeters);
      if (wheelsOffTrack) trackLimitsInvalid = true;
      return snapshot();
    }

    previousProgress = progressMeters;
    previousElapsed = elapsedSeconds;

    // Latched, not instantaneous: one frame with all four wheels off ruins the
    // lap even if the car is back on the asphalt by the next frame. Set BEFORE
    // the wrap is judged, because the finishing frame is part of the lap it
    // finishes - a car that crosses the line with all four wheels in the grass
    // has left the track on the way past it, and reading the flag after the
    // verdict would let that lap through.
    if (wheelsOffTrack) trackLimitsInvalid = true;

    if (wrappedForward) {
      const lapSeconds = elapsedSeconds - lapStartElapsed;
      if (coveredMeters >= half && lapSeconds >= MIN_LAP_SECONDS) {
        // The game's own validity rule, reused rather than restated. The
        // second argument is the race's rewind-scrub flag: the time attack has
        // no rewind, and a teleport abandons its lap outright above rather than
        // letting one be scored, so there is no timing discontinuity left to
        // report here.
        const valid = isQualifyingLapValid(trackLimitsInvalid, false);
        const isBest = valid && (bestLapSeconds === null || lapSeconds < bestLapSeconds);
        if (isBest) bestLapSeconds = lapSeconds;
        lapsCompleted += 1;
        lastLapSeconds = lapSeconds;
        lastLapValid = valid;
        completed = { lapSeconds, valid, isBest };
        lapStartElapsed = elapsedSeconds;
        coveredMeters = 0;
        trackLimitsInvalid = false;
      } else {
        // Not a lap: crossed too soon, too fast, or without having been round.
        // The clock keeps running - exactly how the race's own lapTimer behaves
        // for a spin at the line - and the car has to go round again before
        // the next crossing can count.
        coveredMeters = 0;
      }
    } else if (wrappedBackward) {
      // Reversed over the line. Not a lap, and it does not count as covering
      // the lap either, so the distance starts again from here.
      coveredMeters = 0;
    } else if (step > 0) {
      coveredMeters += step;
    }

    return snapshot();
  }

  return {
    sample,
    state: snapshot,
    reset(elapsedSeconds: number) {
      abandon(elapsedSeconds, previousProgress);
      return snapshot();
    },
  };
}

// ---------------------------------------------------------------------------
// Submission gating
// ---------------------------------------------------------------------------

export interface SubmissionGateOptions {
  /** Quiet period after one submission before another is allowed. */
  minIntervalMs?: number;
  /** Rolling window the per-window cap is counted over. */
  windowMs?: number;
  /** Submissions allowed inside that window. */
  maxInWindow?: number;
}

/**
 * Defaults for a feature where a submission is a courtesy, not a transaction.
 * Twenty seconds is far longer than the gap between two laps even on the
 * shortest circuit, so a real player is never gated; it exists purely to stop
 * a hot loop - a re-firing effect, a completion handler that fires twice -
 * from writing a row a frame. The window cap is the same idea over a longer
 * horizon, so a loop that spaces itself out still cannot flood the table.
 */
export const DEFAULT_SUBMISSION_GATE: Required<SubmissionGateOptions> = {
  minIntervalMs: 20_000,
  windowMs: 3_600_000,
  maxInWindow: 10,
};

/**
 * A monotonic-clock rate limiter for leaderboard writes. Pure: the caller
 * passes the time in, so it is testable without waiting and it cannot be
 * confused by the wall clock jumping (a laptop resuming from sleep, the user
 * changing the system time).
 *
 * Deliberately in-memory and per page load. What this exists to stop is a hot
 * loop inside one session; it is not, and does not claim to be, an anti-abuse
 * control across reloads. The board's own plausibility CHECK is the boundary.
 */
export interface SubmissionGate {
  /** True at most once per allowed interval; records the consumption. */
  tryConsume(nowMs: number): boolean;
  /** Consumptions still inside the rolling window. */
  consumed(): number;
  reset(): void;
}

export function createSubmissionGate(options: SubmissionGateOptions = {}): SubmissionGate {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_SUBMISSION_GATE.minIntervalMs;
  const windowMs = options.windowMs ?? DEFAULT_SUBMISSION_GATE.windowMs;
  const maxInWindow = options.maxInWindow ?? DEFAULT_SUBMISSION_GATE.maxInWindow;
  const times: number[] = [];

  function prune(nowMs: number): void {
    while (times.length > 0 && nowMs - times[0] > windowMs) times.shift();
  }

  return {
    tryConsume(nowMs: number) {
      if (!Number.isFinite(nowMs)) return false;
      prune(nowMs);
      const last = times[times.length - 1];
      // A clock that went backwards reads as "still inside the quiet period"
      // and so rejects, which is the conservative direction: a stuck or
      // rewound Performance.now() can throttle submissions, never accelerate
      // them.
      if (last !== undefined && nowMs - last < minIntervalMs) return false;
      if (times.length >= maxInWindow) return false;
      times.push(nowMs);
      return true;
    },
    consumed: () => times.length,
    reset: () => {
      times.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The board stores an FIA driver CODE, not a name: the column is CHECKed to
 * 2-4 characters and the schema is live, so it cannot be widened here. A typed
 * name is reduced to a code the way a real timing screen does it - leading
 * letters, uppercased, non-alphanumerics dropped.
 *
 * Returns null when the name cannot yield a legal code (nothing, or a single
 * character). The caller must treat that as "drive, but do not submit" rather
 * than inventing a code: a fabricated identity is a lie on a public board, and
 * the CHECK would reject it anyway.
 */
export function driverCodeFromName(name: string): string | null {
  const cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length < 2) return null;
  // Three is the real-world convention and reads better than four; the column
  // allows 2-4, so a four-letter code remains legal for a caller that wants it.
  return cleaned.slice(0, 3);
}

// ---------------------------------------------------------------------------
// Player name storage
// ---------------------------------------------------------------------------

const NAME_KEY = "lift-and-coast.time-attack-name.v1";

type NameStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): NameStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The remembered player name, or null. Never throws; a name is optional. */
export function loadTimeAttackName(storage: NameStorage | null = defaultStorage()): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(NAME_KEY);
    return raw !== null && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Best-effort persist; blocked or full storage must not break driving. */
export function saveTimeAttackName(name: string, storage: NameStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(NAME_KEY, name);
  } catch {
    // Private mode, blocked cookies, or a full quota. The lap still counts and
    // the board still works; only the convenience of remembering is lost.
  }
}
