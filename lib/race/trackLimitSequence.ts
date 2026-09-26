/**
 * Race-control progression for track-limits excursions.
 *
 * The unit is one *excursion*: all four wheels leave, then the car actually
 * rejoins. A long slide is not allowed to silently walk through every stage
 * or charge the penalty repeatedly. The sequence follows the race-control
 * behavior requested for this game: three separate warnings, then black and
 * white on the next separate excursion, then a ladder of escalating time
 * penalties on subsequent ones (5s, then 10s, then a drive-through, then a
 * stop-go) - the FIA's repeat-offender escalation, where each fresh penalty
 * after the warning ladder costs more than the last.
 */

export type TrackLimitStage = "clear" | "warning" | "black-white" | "penalty";

export const TRACK_LIMIT_WARNING_COUNT = 3;
export const TRACK_LIMIT_PENALTY_SECONDS = 5;

/**
 * Repeat-offender penalty ladder after the warning ladder is exhausted:
 * 1st penalty +5s, 2nd +10s, 3rd a drive-through (~20s at pit-lane speed),
 * 4th and beyond a stop-go (~30s standing). Indexed by penaltyCount - 1,
 * clamped at the top rung.
 */
export const TRACK_LIMIT_PENALTY_LADDER_SECONDS: readonly number[] = [5, 10, 20, 30];
export const TRACK_LIMIT_PENALTY_LADDER_LABELS: readonly string[] = [
  "+5s PENALTY",
  "+10s PENALTY",
  "DRIVE-THROUGH",
  "STOP-GO",
];

export function trackLimitPenaltySeconds(penaltyCount: number): number {
  if (penaltyCount < 1) return TRACK_LIMIT_PENALTY_SECONDS;
  return TRACK_LIMIT_PENALTY_LADDER_SECONDS[
    Math.min(penaltyCount, TRACK_LIMIT_PENALTY_LADDER_SECONDS.length) - 1
  ];
}

export function trackLimitPenaltyLabel(penaltyCount: number): string {
  if (penaltyCount < 1) return `+${TRACK_LIMIT_PENALTY_SECONDS}s PENALTY`;
  return TRACK_LIMIT_PENALTY_LADDER_LABELS[
    Math.min(penaltyCount, TRACK_LIMIT_PENALTY_LADDER_LABELS.length) - 1
  ];
}

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
  /**
   * Seconds charged by the most recent penalty episode (from the ladder
   * above), so the caller can apply exactly what the steward decided
   * instead of assuming a flat five seconds.
   */
  lastPenaltySeconds: number;
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
    lastPenaltySeconds: 0,
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
  allFourWheelsOff: boolean
): TrackLimitUpdate {
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
      state.lastPenaltySeconds = trackLimitPenaltySeconds(state.penaltyCount);
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
      return "PENALTY";
    case "clear":
      return "";
  }
}
