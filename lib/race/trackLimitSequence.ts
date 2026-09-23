/**
 * Race-control progression for track-limits excursions.
 *
 * The unit is one *excursion*: all four wheels leave, then the car actually
 * rejoins. A long slide is not allowed to silently walk through every stage
 * or charge the penalty repeatedly. The sequence follows the race-control
 * behavior requested for this game: three separate warnings, then black and
 * white on the next separate excursion, then a single five-second penalty on
 * the following one.
 */

export type TrackLimitStage = "clear" | "warning" | "black-white" | "penalty";

export const TRACK_LIMIT_WARNING_COUNT = 3;
export const TRACK_LIMIT_PENALTY_SECONDS = 5;

export interface TrackLimitSequence {
  stage: TrackLimitStage;
  /** Whether the car is currently in one continuous all-four-wheels-off episode. */
  active: boolean;
  /** Completed warning/flag episodes since the last penalty. */
  offenses: number;
  /** Number of distinct penalty episodes awarded in this race. */
  penaltyCount: number;
  /** True only while the current episode has already been penalized. */
  penaltyApplied: boolean;
}

export interface TrackLimitUpdate {
  stage: TrackLimitStage;
  stageChanged: boolean;
  /** True only on the entry tick of a distinct penalty episode. */
  penaltyJustApplied: boolean;
}

export function createTrackLimitSequence(): TrackLimitSequence {
  return {
    stage: "clear",
    active: false,
    offenses: 0,
    penaltyCount: 0,
    penaltyApplied: false,
  };
}

/** Reset the per-lap warning history while retaining race-level penalties. */
export function resetTrackLimitLap(state: TrackLimitSequence): void {
  state.stage = "clear";
  state.active = false;
  state.offenses = 0;
  state.penaltyApplied = false;
}

/** Reset everything for a new race attempt. */
export function resetTrackLimitSequence(state: TrackLimitSequence): void {
  Object.assign(state, createTrackLimitSequence());
}

export function updateTrackLimitSequence(
  state: TrackLimitSequence,
  allFourWheelsOff: boolean,
  _dt: number
): TrackLimitUpdate {
  void _dt;
  const previousStage = state.stage;
  let penaltyJustApplied = false;

  if (allFourWheelsOff && !state.active) {
    // A new episode starts. The stage is chosen from completed prior
    // episodes, never from how long this one lasts.
    state.active = true;
    if (state.offenses < TRACK_LIMIT_WARNING_COUNT) {
      state.stage = "warning";
    } else if (state.offenses === TRACK_LIMIT_WARNING_COUNT) {
      state.stage = "black-white";
    } else {
      state.stage = "penalty";
      state.penaltyCount += 1;
      state.penaltyApplied = true;
      penaltyJustApplied = true;
    }
  } else if (!allFourWheelsOff && state.active) {
    // Rejoining completes exactly one episode. A penalty episode resets the
    // warning ladder; otherwise it advances it by one.
    state.active = false;
    if (state.penaltyApplied) state.offenses = 0;
    else state.offenses += 1;
    state.penaltyApplied = false;
    state.stage = "clear";
  }

  return {
    stage: state.stage,
    stageChanged: state.stage !== previousStage,
    penaltyJustApplied,
  };
}

export function trackLimitStageLabel(
  stage: TrackLimitStage,
  warningNumber = 1
): string {
  switch (stage) {
    case "warning":
      return `TRACK LIMITS WARNING ${Math.min(
        TRACK_LIMIT_WARNING_COUNT,
        Math.max(1, warningNumber)
      )}/${TRACK_LIMIT_WARNING_COUNT}`;
    case "black-white":
      return "BLACK + WHITE FLAG";
    case "penalty":
      return "+5s PENALTY";
    case "clear":
      return "";
  }
}
