import { describe, expect, it } from "vitest";
import {
  TRACK_LIMIT_BLACK_WHITE_SECONDS,
  TRACK_LIMIT_PENALTY_SECONDS,
  TRACK_LIMIT_WARNING_SECONDS,
  createTrackLimitSequence,
  resetTrackLimitLap,
  trackLimitStageLabel,
  updateTrackLimitSequence,
} from "../lib/race/trackLimitSequence";

describe("track-limits race-control sequence", () => {
  it("warns first, raises black/white second, and penalizes only after that", () => {
    const state = createTrackLimitSequence();

    let result = updateTrackLimitSequence(state, true, 1 / 60);
    expect(result.stage).toBe("warning");
    expect(result.penaltyJustApplied).toBe(false);
    expect(trackLimitStageLabel(state.stage)).toBe("TRACK LIMITS WARNING");

    result = updateTrackLimitSequence(state, true, TRACK_LIMIT_WARNING_SECONDS);
    expect(result.stage).toBe("black-white");
    expect(result.penaltyJustApplied).toBe(false);
    expect(trackLimitStageLabel(state.stage)).toBe("BLACK + WHITE FLAG");

    result = updateTrackLimitSequence(
      state,
      true,
      TRACK_LIMIT_BLACK_WHITE_SECONDS - TRACK_LIMIT_WARNING_SECONDS
    );
    expect(result.stage).toBe("penalty");
    expect(result.penaltyJustApplied).toBe(true);
    expect(TRACK_LIMIT_PENALTY_SECONDS).toBe(5);
    expect(trackLimitStageLabel(state.stage)).toBe("+5s PENALTY");
  });

  it("escalates a later excursion instead of charging on every frame", () => {
    const state = createTrackLimitSequence();

    updateTrackLimitSequence(state, true, 0.2);
    updateTrackLimitSequence(state, false, 1 / 60);
    expect(state.offenses).toBe(1);

    updateTrackLimitSequence(state, true, 0.1);
    expect(state.stage).toBe("black-white");
    expect(state.penaltyApplied).toBe(false);

    updateTrackLimitSequence(state, false, 1 / 60);
    expect(state.offenses).toBe(2);
    updateTrackLimitSequence(state, true, 0.1);
    expect(state.stage).toBe("penalty");
    expect(updateTrackLimitSequence(state, true, 0.3).penaltyJustApplied).toBe(true);
  });

  it("resets the warning history per lap but does not erase a race penalty", () => {
    const state = createTrackLimitSequence();
    updateTrackLimitSequence(state, true, 2);
    expect(state.penaltyApplied).toBe(true);
    resetTrackLimitLap(state);
    expect(state.stage).toBe("clear");
    expect(state.offenses).toBe(0);
    expect(state.penaltyApplied).toBe(true);
  });
});
