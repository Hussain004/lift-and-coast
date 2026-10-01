import { describe, expect, it } from "vitest";
import {
  PIT_RELEASE_EARLY_PENALTY_SECONDS,
  PIT_RELEASE_FAST_SECONDS,
  PIT_RELEASE_MAX_CREDIT_SECONDS,
  PIT_RELEASE_RESULT_SECONDS,
  PIT_RELEASE_WINDOW_SECONDS,
  createPitReleaseState,
  pitReleaseCredit,
  pitReleaseHint,
  stepPitRelease,
  type PitReleaseState,
} from "../lib/race/pitRelease";
import { pitCamActive } from "../lib/race/pitCam";

const DT = 1 / 60;

/** Runs a stop through the whole service, pressing nothing. */
function armAndFinish(state: PitReleaseState, enabled = true) {
  stepPitRelease(state, { dt: DT, inService: true, pressed: false, enabled });
  stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled });
  return state;
}

/** Ticks the green window open for `seconds`, pressing nothing. */
function idleGreen(state: PitReleaseState, seconds: number) {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled: true });
  }
}

/** Ticks any phase out entirely (used to expire the result line). */
function settle(state: PitReleaseState, seconds: number) {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) {
    stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled: true });
  }
}

describe("the pit release", () => {
  it("arms on the service and opens the green window when the crew finishes", () => {
    const state = createPitReleaseState();
    expect(state.phase).toBe("idle");
    // A request on its own arms nothing - only a running service does.
    stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled: true });
    expect(state.phase).toBe("idle");
    stepPitRelease(state, { dt: DT, inService: true, pressed: false, enabled: true });
    expect(state.phase).toBe("armed");
    // Completion is detected on the service flag going false, because
    // strategy.ts zeroes pitProgress on the same tick it completes.
    stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled: true });
    expect(state.phase).toBe("green");
    expect(state.windowLeft).toBeCloseTo(PIT_RELEASE_WINDOW_SECONDS, 6);
  });

  it("pays the full credit for a press the instant the light goes green", () => {
    const state = armAndFinish(createPitReleaseState());
    const outcome = stepPitRelease(state, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(outcome).toEqual({ kind: "credit", seconds: PIT_RELEASE_MAX_CREDIT_SECONDS });
    expect(state.phase).toBe("resolved");
    expect(state.creditSeconds).toBeCloseTo(0.4, 10);
  });

  it("tapers the credit the slower you are, and pays nothing at the edge", () => {
    const quick = armAndFinish(createPitReleaseState());
    idleGreen(quick, PIT_RELEASE_FAST_SECONDS * 0.9);
    const fast = stepPitRelease(quick, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(fast).toEqual({ kind: "credit", seconds: PIT_RELEASE_MAX_CREDIT_SECONDS });

    const slow = armAndFinish(createPitReleaseState());
    idleGreen(slow, (PIT_RELEASE_FAST_SECONDS + PIT_RELEASE_WINDOW_SECONDS) / 2);
    const mid = stepPitRelease(slow, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(mid!.kind).toBe("credit");
    expect(mid!.seconds).toBeGreaterThan(0);
    expect(mid!.seconds).toBeLessThan(PIT_RELEASE_MAX_CREDIT_SECONDS);

    // Monotonic and bounded across the whole window.
    let previous = Infinity;
    for (let elapsed = 0; elapsed <= PIT_RELEASE_WINDOW_SECONDS; elapsed += 0.05) {
      const credit = pitReleaseCredit(elapsed);
      expect(credit).toBeLessThanOrEqual(PIT_RELEASE_MAX_CREDIT_SECONDS);
      expect(credit).toBeLessThanOrEqual(previous + 1e-12);
      previous = credit;
    }
    expect(pitReleaseCredit(PIT_RELEASE_WINDOW_SECONDS)).toBeCloseTo(0, 10);
    expect(pitReleaseCredit(0)).toBe(PIT_RELEASE_MAX_CREDIT_SECONDS);
    // Never negative, even for a nonsense elapsed time.
    expect(pitReleaseCredit(-5)).toBe(PIT_RELEASE_MAX_CREDIT_SECONDS);
  });

  it("a late press is a miss, not a smaller credit", () => {
    const state = armAndFinish(createPitReleaseState());
    idleGreen(state, PIT_RELEASE_WINDOW_SECONDS + 0.05);
    expect(state.phase).toBe("missed");
    expect(stepPitRelease(state, { dt: DT, inService: false, pressed: true, enabled: true })).toBeNull();
    expect(state.creditSeconds).toBe(0);
  });

  it("pressing before the light costs the penalty and forfeits the credit", () => {
    const state = createPitReleaseState();
    stepPitRelease(state, { dt: DT, inService: true, pressed: true, enabled: true });
    expect(state.phase).toBe("armed");
    expect(state.faulted).toBe(true);
    expect(state.penaltySeconds).toBe(PIT_RELEASE_EARLY_PENALTY_SECONDS);
    // The green window still opens - the driver is not left in limbo - but
    // it is worth nothing.
    stepPitRelease(state, { dt: DT, inService: false, pressed: false, enabled: true });
    expect(state.phase).toBe("green");
    const outcome = stepPitRelease(state, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(outcome).toBeNull();
    expect(state.creditSeconds).toBe(0);
  });

  it("one press per stop: holding or mashing the key cannot farm it", () => {
    const state = createPitReleaseState();
    // Five separate early presses: the first costs, the rest are free.
    let charged = 0;
    for (let i = 0; i < 5; i++) {
      const outcome = stepPitRelease(state, { dt: DT, inService: true, pressed: true, enabled: true });
      if (outcome?.kind === "early") charged++;
    }
    expect(charged).toBe(1);

    // And the credit can only be taken once.
    const second = armAndFinish(createPitReleaseState());
    const first = stepPitRelease(second, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(first!.kind).toBe("credit");
    expect(second.phase).toBe("resolved");
    for (let i = 0; i < 10; i++) {
      expect(stepPitRelease(second, { dt: DT, inService: false, pressed: true, enabled: true })).toBeNull();
    }
    expect(second.creditSeconds).toBe(first!.seconds);
  });

  it("three stops in a row each pay at most the ceiling, then reset cleanly", () => {
    const state = createPitReleaseState();
    const total = [];
    for (let stop = 0; stop < 3; stop++) {
      armAndFinish(state);
      const outcome = stepPitRelease(state, { dt: DT, inService: false, pressed: true, enabled: true });
      total.push(outcome?.kind === "credit" ? outcome.seconds : 0);
      settle(state, PIT_RELEASE_RESULT_SECONDS + 0.1);
      expect(state.phase).toBe("idle");
    }
    for (const seconds of total) {
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(PIT_RELEASE_MAX_CREDIT_SECONDS);
    }
  });

  it("disabled is a total no-op: no light, no credit, no penalty", () => {
    const state = createPitReleaseState();
    stepPitRelease(state, { dt: DT, inService: true, pressed: true, enabled: false });
    expect(state.phase).toBe("idle");
    for (let i = 0; i < 200; i++) {
      expect(stepPitRelease(state, { dt: DT, inService: true, pressed: true, enabled: false })).toBeNull();
    }
    expect(state.penaltySeconds).toBe(0);
    expect(state.creditSeconds).toBe(0);
    // Turning it off mid-stop clears an in-flight state rather than leaving
    // a window the player could still be timed against.
    const live = armAndFinish(createPitReleaseState());
    expect(live.phase).toBe("green");
    expect(stepPitRelease(live, { dt: DT, inService: false, pressed: true, enabled: false })).toBeNull();
    expect(live.phase).toBe("idle");
  });

  it("a long frame cannot shorten the window past zero, and a negative one cannot re-open it", () => {
    const state = armAndFinish(createPitReleaseState());
    stepPitRelease(state, { dt: 30, inService: false, pressed: false, enabled: true });
    expect(state.windowLeft).toBe(0);
    expect(state.phase).toBe("missed");
    expect(state.creditSeconds).toBe(0);
    // A negative dt (a clock that went backwards) must not re-open anything.
    const other = armAndFinish(createPitReleaseState());
    stepPitRelease(other, { dt: -5, inService: false, pressed: false, enabled: true });
    expect(other.phase).toBe("green");
  });
});

describe("pitReleaseHint", () => {
  it("says nothing between stops and something useful during one", () => {
    expect(pitReleaseHint(createPitReleaseState(), "7", 0)).toBe("");
    const armed = createPitReleaseState();
    stepPitRelease(armed, { dt: DT, inService: true, pressed: false, enabled: true });
    expect(pitReleaseHint(armed, "7", 0.5)).toBe("PIT STOP · 50% · GREEN = GO");
    const green = armAndFinish(createPitReleaseState());
    expect(pitReleaseHint(green, "7", 1)).toBe("GREEN · HIT 7");
    stepPitRelease(green, { dt: DT, inService: false, pressed: true, enabled: true });
    expect(pitReleaseHint(green, "7", 1)).toBe("CLEAN RELEASE · -0.40s");
  });

  it("names the bound key, so a rebind shows up in the hint", () => {
    const green = armAndFinish(createPitReleaseState());
    expect(pitReleaseHint(green, "Numpad 0", 1)).toBe("GREEN · HIT Numpad 0");
  });

  it("tells the player when the light is burned and when they missed it", () => {
    const early = createPitReleaseState();
    stepPitRelease(early, { dt: DT, inService: true, pressed: true, enabled: true });
    expect(pitReleaseHint(early, "7", 0.2)).toBe("PIT STOP · 20% · GREEN LIGHT BURNED");
    stepPitRelease(early, { dt: DT, inService: false, pressed: false, enabled: true });
    expect(pitReleaseHint(early, "7", 1)).toBe("GREEN · NO CREDIT LEFT");

    const missed = armAndFinish(createPitReleaseState());
    idleGreen(missed, PIT_RELEASE_WINDOW_SECONDS + 0.05);
    expect(pitReleaseHint(missed, "7", 1)).toBe("MISSED THE GREEN");
  });
});

describe("pitCamActive", () => {
  it("holds through the service and the green window, then hands the camera back", () => {
    expect(pitCamActive({ pitPhase: "none", releasePhase: "idle" })).toBe(false);
    expect(pitCamActive({ pitPhase: "requested", releasePhase: "idle" })).toBe(false);
    expect(pitCamActive({ pitPhase: "service", releasePhase: "armed" })).toBe(true);
    expect(pitCamActive({ pitPhase: "none", releasePhase: "green" })).toBe(true);
    // Once the release has resolved the player is driving again, so the view
    // goes straight back to whatever camera they had chosen.
    expect(pitCamActive({ pitPhase: "none", releasePhase: "resolved" })).toBe(false);
    expect(pitCamActive({ pitPhase: "none", releasePhase: "missed" })).toBe(false);
  });
});
