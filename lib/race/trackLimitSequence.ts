/**
 * Race-control progression for a track-limits excursion.
 *
 * A momentary wide moment is not an instant +5s in the rules-inspired
 * presentation: the driver first sees a warning, a sustained or repeated
 * offense raises the black-and-white flag, and the penalty is applied only
 * after that stage. The state is deliberately small and pure so the same
 * sequence can be tested without a browser or a physics world.
 */

export type TrackLimitStage = "clear" | "warning" | "black-white" | "penalty";

export const TRACK_LIMIT_WARNING_SECONDS = 0.55;
export const TRACK_LIMIT_BLACK_WHITE_SECONDS = 1.35;
export const TRACK_LIMIT_PENALTY_SECONDS = 5;

export interface TrackLimitSequence {
  stage: TrackLimitStage;
  /** Whether the car is currently outside all four wheels' legal surface. */
  active: boolean;
  /** Seconds spent in the current continuous excursion. */
  episodeSeconds: number;
  /** Completed excursions without a penalty, used to escalate on a re-entry. */
  offenses: number;
  /** A penalty can be applied only once per race until the next race. */
  penaltyApplied: boolean;
}

export interface TrackLimitUpdate {
  stage: TrackLimitStage;
  stageChanged: boolean;
  /** True only on the tick which applies the race-time penalty. */
  penaltyJustApplied: boolean;
}

export function createTrackLimitSequence(): TrackLimitSequence {
  return {
    stage: "clear",
    active: false,
    episodeSeconds: 0,
    offenses: 0,
    penaltyApplied: false,
  };
}

/** Reset the per-lap warning history while retaining whether a penalty was
 * already awarded in this race. */
export function resetTrackLimitLap(state: TrackLimitSequence): void {
  state.stage = "clear";
  state.active = false;
  state.episodeSeconds = 0;
  state.offenses = 0;
}

/** Reset everything for a new race attempt. */
export function resetTrackLimitSequence(state: TrackLimitSequence): void {
  Object.assign(state, createTrackLimitSequence());
}

export function updateTrackLimitSequence(
  state: TrackLimitSequence,
  allFourWheelsOff: boolean,
  dt: number
): TrackLimitUpdate {
  const previousStage = state.stage;
  let penaltyJustApplied = false;

  if (allFourWheelsOff) {
    if (!state.active) {
      state.active = true;
      state.episodeSeconds = 0;
      // A first offense starts at warning; a second starts at black/white;
      // a third starts at the penalty stage. The short dwell before the
      // penalty prevents a single render-frame glitch from costing time.
      state.stage = state.offenses === 0 ? "warning" : state.offenses === 1 ? "black-white" : "penalty";
    }
    state.episodeSeconds += Math.max(0, dt);

    if (state.stage === "warning" && state.episodeSeconds >= TRACK_LIMIT_WARNING_SECONDS) {
      state.stage = "black-white";
    }
    if (state.stage === "black-white" && state.episodeSeconds >= TRACK_LIMIT_BLACK_WHITE_SECONDS) {
      state.stage = "penalty";
    }
    if (state.stage === "penalty" && !state.penaltyApplied && state.episodeSeconds >= 0.35) {
      state.penaltyApplied = true;
      penaltyJustApplied = true;
    }
  } else if (state.active) {
    // Returning to the track completes the episode. A warning/black-white
    // offense is remembered for escalation on the next excursion; a penalty
    // is not counted twice.
    if (!state.penaltyApplied) state.offenses += 1;
    state.active = false;
    state.episodeSeconds = 0;
    if (!state.penaltyApplied) state.stage = "clear";
  }

  return {
    stage: state.stage,
    stageChanged: state.stage !== previousStage,
    penaltyJustApplied,
  };
}

export function trackLimitStageLabel(stage: TrackLimitStage): string {
  switch (stage) {
    case "warning":
      return "TRACK LIMITS WARNING";
    case "black-white":
      return "BLACK + WHITE FLAG";
    case "penalty":
      return "+5s PENALTY";
    case "clear":
      return "";
  }
}
