import { describe, expect, it } from "vitest";
import {
  TRACK_LIMIT_PENALTY_LADDER_LABELS,
  TRACK_LIMIT_PENALTY_LADDER_SECONDS,
  TRACK_LIMIT_PENALTY_SECONDS,
  TRACK_LIMIT_WARNING_COUNT,
  createTrackLimitSequence,
  resetTrackLimitLap,
  trackLimitPenaltyLabel,
  trackLimitPenaltySeconds,
  trackLimitStageLabel,
  updateTrackLimitSequence,
} from "../lib/race/trackLimitSequence";

describe("track-limits race-control sequence", () => {
  it("gives three separate warnings before black/white and a later penalty", () => {
    const state = createTrackLimitSequence();

    for (let warning = 1; warning <= TRACK_LIMIT_WARNING_COUNT; warning++) {
      let result = updateTrackLimitSequence(state, true);
      expect(result.stage).toBe("warning");
      expect(result.penaltyJustApplied).toBe(false);
      expect(trackLimitStageLabel(state.stage, warning)).toBe(
        `TRACK LIMITS WARNING ${warning}/${TRACK_LIMIT_WARNING_COUNT}`
      );
      // A long single episode cannot advance or charge again.
      for (let i = 0; i < 600; i++) {
        result = updateTrackLimitSequence(state, true);
      }
      expect(result.stage).toBe("warning");
      expect(result.penaltyJustApplied).toBe(false);
      updateTrackLimitSequence(state, false);
    }

    let result = updateTrackLimitSequence(state, true);
    expect(result.stage).toBe("black-white");
    expect(result.penaltyJustApplied).toBe(false);
    expect(trackLimitStageLabel(state.stage)).toBe("BLACK + WHITE FLAG");
    updateTrackLimitSequence(state, false);

    result = updateTrackLimitSequence(state, true);
    expect(result.stage).toBe("penalty");
    expect(result.penaltyJustApplied).toBe(true);
    expect(state.penaltyCount).toBe(1);
    expect(state.lastPenaltySeconds).toBe(TRACK_LIMIT_PENALTY_SECONDS);
    expect(TRACK_LIMIT_PENALTY_SECONDS).toBe(5);

    // A long single penalty episode cannot charge again before re-entry.
    for (let i = 0; i < 600; i++) {
      result = updateTrackLimitSequence(state, true);
    }
    expect(result.penaltyJustApplied).toBe(false);
    expect(state.penaltyCount).toBe(1);
  });

  it("escalates repeat penalties up the FIA ladder", () => {
    const state = createTrackLimitSequence();
    // Walk the ladder one episode at a time. Each penalty episode resets the
    // warning ladder, so every rung after the first costs a full
    // 3-warnings + black/white + penalty walk (TRACK_LIMIT_WARNING_COUNT + 2).
    const episodesToPenalty = TRACK_LIMIT_WARNING_COUNT + 2;
    for (let episode = 0; episode < episodesToPenalty; episode++) {
      updateTrackLimitSequence(state, true);
      updateTrackLimitSequence(state, false);
    }
    expect(state.penaltyCount).toBe(1);
    expect(state.lastPenaltySeconds).toBe(TRACK_LIMIT_PENALTY_LADDER_SECONDS[0]);
    expect(trackLimitPenaltyLabel(state.penaltyCount)).toBe(TRACK_LIMIT_PENALTY_LADDER_LABELS[0]);

    for (let rung = 1; rung < TRACK_LIMIT_PENALTY_LADDER_SECONDS.length; rung++) {
      for (let episode = 0; episode < episodesToPenalty; episode++) {
        updateTrackLimitSequence(state, true);
        updateTrackLimitSequence(state, false);
      }
      expect(state.penaltyCount).toBe(rung + 1);
      expect(state.lastPenaltySeconds).toBe(TRACK_LIMIT_PENALTY_LADDER_SECONDS[rung]);
      expect(trackLimitPenaltyLabel(state.penaltyCount)).toBe(
        TRACK_LIMIT_PENALTY_LADDER_LABELS[rung]
      );
    }

    // Past the top rung the penalty stays at the stop-go ceiling.
    for (let episode = 0; episode < episodesToPenalty; episode++) {
      updateTrackLimitSequence(state, true);
      updateTrackLimitSequence(state, false);
    }
    expect(state.penaltyCount).toBe(TRACK_LIMIT_PENALTY_LADDER_SECONDS.length + 1);
    expect(state.lastPenaltySeconds).toBe(
      TRACK_LIMIT_PENALTY_LADDER_SECONDS[TRACK_LIMIT_PENALTY_LADDER_SECONDS.length - 1]
    );
    expect(trackLimitPenaltySeconds(99)).toBe(
      TRACK_LIMIT_PENALTY_LADDER_SECONDS[TRACK_LIMIT_PENALTY_LADDER_SECONDS.length - 1]
    );
  });

  it("starts a fresh three-warning ladder after a penalty and rejoin", () => {
    const state = createTrackLimitSequence();
    for (let i = 0; i < TRACK_LIMIT_WARNING_COUNT; i++) {
      updateTrackLimitSequence(state, true);
      updateTrackLimitSequence(state, false);
    }
    updateTrackLimitSequence(state, true); // black/white
    updateTrackLimitSequence(state, false);
    updateTrackLimitSequence(state, true); // penalty
    expect(state.penaltyCount).toBe(1);
    updateTrackLimitSequence(state, false);
    expect(updateTrackLimitSequence(state, true).stage).toBe("warning");
    expect(state.penaltyCount).toBe(1);
  });

  it("resets the warning history per lap but retains race penalty count", () => {
    const state = createTrackLimitSequence();
    for (let i = 0; i < TRACK_LIMIT_WARNING_COUNT + 2; i++) {
      updateTrackLimitSequence(state, true);
      updateTrackLimitSequence(state, false);
    }
    expect(state.penaltyCount).toBe(1);
    resetTrackLimitLap(state);
    expect(state.stage).toBe("clear");
    expect(state.offenses).toBe(0);
    expect(state.penaltyCount).toBe(1);
  });
});
