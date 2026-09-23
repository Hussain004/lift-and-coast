import { describe, expect, it } from "vitest";
import {
  TRACK_LIMIT_PENALTY_SECONDS,
  createTrackLimitSequence,
  resetTrackLimitLap,
  trackLimitStageLabel,
  updateTrackLimitSequence,
} from "../lib/race/trackLimitSequence";

describe("track-limits race-control sequence", () => {
  it("warns, flags, and penalizes only on separate excursions", () => {
    const state = createTrackLimitSequence();

    let result = updateTrackLimitSequence(state, true, 1 / 60);
    expect(result.stage).toBe("warning");
    expect(result.penaltyJustApplied).toBe(false);
    expect(trackLimitStageLabel(state.stage)).toBe("TRACK LIMITS WARNING");

    // Holding the same off-track state for a long time must not advance it.
    for (let i = 0; i < 600; i++) {
      result = updateTrackLimitSequence(state, true, 1 / 60);
    }
    expect(result.stage).toBe("warning");
    expect(result.penaltyJustApplied).toBe(false);
    expect(state.penaltyCount).toBe(0);

    updateTrackLimitSequence(state, false, 1 / 60);
    result = updateTrackLimitSequence(state, true, 1 / 60);
    expect(result.stage).toBe("black-white");
    expect(result.penaltyJustApplied).toBe(false);
    expect(trackLimitStageLabel(state.stage)).toBe("BLACK + WHITE FLAG");

    updateTrackLimitSequence(state, false, 1 / 60);
    result = updateTrackLimitSequence(state, true, 1 / 60);
    expect(result.stage).toBe("penalty");
    expect(result.penaltyJustApplied).toBe(true);
    expect(state.penaltyCount).toBe(1);
    expect(TRACK_LIMIT_PENALTY_SECONDS).toBe(5);

    // A long single penalty episode cannot charge again before re-entry.
    for (let i = 0; i < 600; i++) {
      result = updateTrackLimitSequence(state, true, 1 / 60);
    }
    expect(result.penaltyJustApplied).toBe(false);
    expect(state.penaltyCount).toBe(1);
  });

  it("starts a fresh warning ladder after a penalty and rejoin", () => {
    const state = createTrackLimitSequence();
    updateTrackLimitSequence(state, true, 0.016);
    updateTrackLimitSequence(state, false, 0.016);
    updateTrackLimitSequence(state, true, 0.016);
    updateTrackLimitSequence(state, false, 0.016);
    updateTrackLimitSequence(state, true, 0.016);
    expect(state.penaltyCount).toBe(1);
    updateTrackLimitSequence(state, false, 0.016);
    expect(updateTrackLimitSequence(state, true, 0.016).stage).toBe("warning");
    expect(state.penaltyCount).toBe(1);
  });

  it("resets the warning history per lap but retains race penalty count", () => {
    const state = createTrackLimitSequence();
    updateTrackLimitSequence(state, true, 0.016);
    updateTrackLimitSequence(state, false, 0.016);
    updateTrackLimitSequence(state, true, 0.016);
    updateTrackLimitSequence(state, false, 0.016);
    updateTrackLimitSequence(state, true, 0.016);
    expect(state.penaltyCount).toBe(1);
    resetTrackLimitLap(state);
    expect(state.stage).toBe("clear");
    expect(state.offenses).toBe(0);
    expect(state.penaltyCount).toBe(1);
  });
});
