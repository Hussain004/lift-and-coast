// The pit-stop RELEASE: the driver half of a stop, as a small timing game.
//
// The service itself belongs to strategy.ts (PIT_SERVICE_SECONDS, the damage
// repair, the blankets). This module is the moment AFTER it: the lollipop
// goes green, the driver has a short window to hit the release, and a clean
// hit is worth a slice of race time.
//
// Three rules shape it:
//
//  1. The reward is a REDUCTION of race time, never a force or a thrust. A
//     stop must not be able to make the car faster, or the whole
//     engine-force ceiling documented in strategy.ts stops meaning anything.
//  2. One press per stop is worth anything at all. The edge is consumed by
//     the first press, so holding or mashing the key cannot farm credits.
//  3. Pressing early is a real cost, not a wasted click: a flat time
//     penalty and the stop's credit forfeited, so the key has to be READ,
//     not just held down.
//
// Pure and headless - Car.tsx owns the instance and applies the outcome to
// the race clock; nothing here touches the vehicle, the track, or the DOM.

/**
 * How long the lollipop stays green before a missed release is final.
 * Long enough to react to the light going out, short enough that the driver
 * is not sitting on a free 0.4 s if they look away for a moment.
 */
export const PIT_RELEASE_WINDOW_SECONDS = 1.2;

/** Best case: hit it the instant the light goes green. */
export const PIT_RELEASE_MAX_CREDIT_SECONDS = 0.4;

/**
 * Inside this the full credit is paid. Outside it the credit tapers to zero
 * by the end of the window, so a quick clean reaction is the skill being
 * rewarded and a lucky late scramble is worth almost nothing.
 */
export const PIT_RELEASE_FAST_SECONDS = 0.35;

/** Cost of hitting the key before the light: flat, once per stop. */
export const PIT_RELEASE_EARLY_PENALTY_SECONDS = 0.4;

/**
 * How long the "you released cleanly" / "you missed it" line stays on the
 * HUD after the light closes. Matches how long the crew stays in shot.
 */
export const PIT_RELEASE_RESULT_SECONDS = 1.6;

/**
 * Where the release is: idle between stops, armed while the crew works
 * (lollipop red), green for the window after they finish (lollipop green),
 * then resolved or missed for as long as the result line stays up.
 */
export type PitReleasePhase = "idle" | "armed" | "green" | "resolved" | "missed";

export interface PitReleaseState {
  phase: PitReleasePhase;
  /** Seconds of green window left (phase "green"). */
  windowLeft: number;
  /** Seconds left on the result line (phases "resolved" and "missed"). */
  resultLeft: number;
  /** Time credit this stop paid out, seconds (0 when missed). */
  creditSeconds: number;
  /** Flat penalty charged for an early press this stop, seconds. */
  penaltySeconds: number;
  /** Was the key hit before the light on this stop. */
  faulted: boolean;
}

export interface PitReleaseUpdate {
  dt: number;
  /** strategy.ts is running the stop right now. */
  inService: boolean;
  /** Edge-triggered release key, consumed by the step that reads it. */
  pressed: boolean;
  /** The pause-menu setting: off means no light, no credit, no penalty. */
  enabled: boolean;
}

/**
 * Advances the release state machine by one tick and returns the outcome if
 * this tick was the one that scored (or cost) something.
 *
 * The completion edge is detected on `inService` going false, NOT on
 * pitProgress: strategy.ts resets pitProgress to 0 on the same tick it
 * flips the phase, so a progress of exactly 1 is never observable.
 */
export function stepPitRelease(
  state: PitReleaseState,
  update: PitReleaseUpdate
): PitReleaseOutcome | null {
  const dt = Math.max(0, update.dt);
  // Disabled is a true no-op: the stop runs on strategy.ts's own timer and
  // the key does nothing at all, so the feature can be switched off without
  // any of its numbers leaking into the race.
  if (!update.enabled) {
    if (state.phase !== "idle") reset(state);
    return null;
  }

  switch (state.phase) {
    case "idle":
      if (!update.inService) return null;
      // A service begins. The tick that arms it is handled by the "armed"
      // branch rather than returning here, so a key already down on the very
      // first tick of the stop is an early press rather than a swallowed
      // edge - the crew are working from that instant, so it must not be a
      // free one.
      state.phase = "armed";
      state.windowLeft = 0;
      state.resultLeft = 0;
      state.creditSeconds = 0;
      state.penaltySeconds = 0;
      state.faulted = false;
      return stepPitRelease(state, update);

    case "armed":
      if (!update.inService) {
        // The crew finished: the lollipop goes green.
        state.phase = "green";
        state.windowLeft = PIT_RELEASE_WINDOW_SECONDS;
        return null;
      }
      // The first press of the stop decides it. Later presses, or a held
      // key, find `faulted` already set and cost nothing more.
      if (update.pressed && !state.faulted) {
        state.faulted = true;
        state.penaltySeconds = PIT_RELEASE_EARLY_PENALTY_SECONDS;
        return { kind: "early", seconds: PIT_RELEASE_EARLY_PENALTY_SECONDS };
      }
      return null;

    case "green": {
      state.windowLeft -= dt;
      if (update.pressed) {
        const elapsed = PIT_RELEASE_WINDOW_SECONDS - Math.max(0, state.windowLeft);
        const seconds = state.faulted ? 0 : pitReleaseCredit(elapsed);
        state.creditSeconds = seconds;
        state.phase = "resolved";
        state.resultLeft = PIT_RELEASE_RESULT_SECONDS;
        return seconds > 0 ? { kind: "credit", seconds } : null;
      }
      if (state.windowLeft <= 0) {
        state.windowLeft = 0;
        state.phase = "missed";
        state.resultLeft = PIT_RELEASE_RESULT_SECONDS;
        state.creditSeconds = 0;
      }
      return null;
    }

    case "resolved":
    case "missed":
      state.resultLeft -= dt;
      if (state.resultLeft <= 0) reset(state);
      return null;
  }
}

/** The HUD line for the release, or "" when there is nothing to say. */
export function pitReleaseHint(
  state: PitReleaseState,
  keyLabel: string,
  serviceProgress: number
): string {
  if (state.phase === "armed") {
    const progress = `PIT STOP · ${Math.round(serviceProgress * 100)}%`;
    return state.faulted ? `${progress} · GREEN LIGHT BURNED` : `${progress} · GREEN = GO`;
  }
  if (state.phase === "green") {
    return state.faulted ? "GREEN · NO CREDIT LEFT" : `GREEN · HIT ${keyLabel}`;
  }
  if (state.phase === "resolved") {
    return state.creditSeconds > 0
      ? `CLEAN RELEASE · -${state.creditSeconds.toFixed(2)}s`
      : "RELEASED · NO CREDIT";
  }
  if (state.phase === "missed") return "MISSED THE GREEN";
  return "";
}

/** What a stop paid out, or cost, this tick. */
export type PitReleaseOutcome =
  | { kind: "credit"; seconds: number }
  | { kind: "early"; seconds: number };

export function createPitReleaseState(): PitReleaseState {
  return {
    phase: "idle",
    windowLeft: 0,
    resultLeft: 0,
    creditSeconds: 0,
    penaltySeconds: 0,
    faulted: false,
  };
}

function reset(state: PitReleaseState): void {
  state.phase = "idle";
  state.windowLeft = 0;
  state.resultLeft = 0;
  state.creditSeconds = 0;
  state.penaltySeconds = 0;
  state.faulted = false;
}

/**
 * The credit for a press `elapsed` seconds after the light: full inside
 * PIT_RELEASE_FAST_SECONDS, then a straight taper to nothing at the end of
 * the window. Always clamped, so a hand-tuned window can never pay out
 * more than the ceiling.
 */
export function pitReleaseCredit(elapsed: number): number {
  const span = PIT_RELEASE_WINDOW_SECONDS - PIT_RELEASE_FAST_SECONDS;
  const scale = span <= 0 ? 0 : (elapsed - PIT_RELEASE_FAST_SECONDS) / span;
  return PIT_RELEASE_MAX_CREDIT_SECONDS * Math.max(0, Math.min(1, 1 - scale));
}