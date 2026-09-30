import { describe, expect, it } from "vitest";
import {
  SC_CAP_MS,
  STOPPED_CAR_SECONDS,
  VSC_CAP_MS,
  catchUpBonusMs,
  createSafetyCarState,
  gapAheadMeters,
  planSafetyCar,
  safetyCarCapMs,
  safetyCarText,
  stepSafetyCar,
  type SafetyCarInput,
  type SafetyCarPeriod,
} from "../lib/race/safetyCar";

const base: SafetyCarInput = { dt: 1 / 60, leaderLaps: 0, raceLaps: 5, racing: true, stoppedCarSeconds: 0, reactive: true };

describe("safety car plan", () => {
  it("is off when off or the race is too short, and deterministic otherwise", () => {
    expect(planSafetyCar("off", 10, 1)).toEqual([]);
    expect(planSafetyCar("frequent", 2, 1)).toEqual([]);
    expect(planSafetyCar("frequent", 8, 42)).toEqual(planSafetyCar("frequent", 8, 42));
  });

  it("keeps every period inside the race and apart from the next", () => {
    let withEvent = 0;
    for (let seed = 0; seed < 200; seed++) {
      const plan = planSafetyCar("frequent", 10, seed);
      if (plan.length) withEvent++;
      plan.forEach((p, i) => {
        expect(p.startLaps).toBeGreaterThanOrEqual(0.7);
        expect(p.startLaps + p.durationLaps).toBeLessThan(10 - 1.5);
        if (i > 0) expect(p.startLaps).toBeGreaterThan(plan[i - 1].startLaps + plan[i - 1].durationLaps + 1);
      });
    }
    expect(withEvent).toBeGreaterThan(120);
    const rare = Array.from({ length: 200 }, (_, s) => planSafetyCar("rare", 10, s).length);
    expect(Math.max(...rare)).toBe(1);
    expect(rare.filter(Boolean).length).toBeLessThan(withEvent);
  });
});

describe("safety car state machine", () => {
  const scPlan: SafetyCarPeriod[] = [{ kind: "sc", startLaps: 1.2, durationLaps: 1 }];

  it("deploys at the planned distance, holds the cap, and greens at the end of the in-lap", () => {
    const s = createSafetyCarState(scPlan);
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1.1 })).toBeNull();
    expect(safetyCarCapMs(s)).toBeNull();
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1.2 })).toEqual({ type: "deploy", kind: "sc" });
    expect(safetyCarCapMs(s)).toBe(SC_CAP_MS);
    expect(safetyCarText(s)).toContain("SAFETY CAR");
    expect(stepSafetyCar(s, { ...base, leaderLaps: 2.1 })).toBeNull();
    expect(stepSafetyCar(s, { ...base, leaderLaps: 2.2 })).toEqual({ type: "ending", kind: "sc" });
    expect(safetyCarCapMs(s)).toBe(SC_CAP_MS); // still capped while it comes in
    expect(stepSafetyCar(s, { ...base, leaderLaps: 2.9 })).toBeNull();
    expect(stepSafetyCar(s, { ...base, leaderLaps: 3.0 })).toEqual({ type: "green", kind: "sc" });
    expect(safetyCarCapMs(s)).toBeNull();
  });

  it("ends a VSC on a short timer", () => {
    const s = createSafetyCarState([{ kind: "vsc", startLaps: 1, durationLaps: 0.8 }]);
    stepSafetyCar(s, { ...base, leaderLaps: 1 });
    expect(safetyCarCapMs(s)).toBe(VSC_CAP_MS);
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1.8 })).toEqual({ type: "ending", kind: "vsc" });
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1.8, dt: 2 })).toBeNull();
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1.8, dt: 2.5 })).toEqual({ type: "green", kind: "vsc" });
  });

  it("calls a VSC for a stopped car, once, then holds off", () => {
    const s = createSafetyCarState([]);
    expect(stepSafetyCar(s, { ...base, leaderLaps: 0.2, stoppedCarSeconds: 20 })).toBeNull(); // too early
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1, stoppedCarSeconds: STOPPED_CAR_SECONDS - 1 })).toBeNull();
    expect(stepSafetyCar(s, { ...base, leaderLaps: 1, stoppedCarSeconds: STOPPED_CAR_SECONDS })).toEqual({ type: "deploy", kind: "vsc" });
    stepSafetyCar(s, { ...base, leaderLaps: 1.8 });
    stepSafetyCar(s, { ...base, leaderLaps: 1.8, dt: 5 });
    expect(safetyCarCapMs(s)).toBeNull();
    // Cooldown: the same stopped car does not re-trigger straight away.
    expect(stepSafetyCar(s, { ...base, leaderLaps: 2, stoppedCarSeconds: 30 })).toBeNull();
    // A setting that forbids reactive calls never deploys.
    const quiet = createSafetyCarState([]);
    expect(stepSafetyCar(quiet, { ...base, leaderLaps: 1, stoppedCarSeconds: 30, reactive: false })).toBeNull();
  });

  it("never runs into the end of the race and clears when racing stops", () => {
    const s = createSafetyCarState([{ kind: "sc", startLaps: 3, durationLaps: 1 }]);
    stepSafetyCar(s, { ...base, leaderLaps: 3 });
    expect(stepSafetyCar(s, { ...base, leaderLaps: 4.6 })).toEqual({ type: "green", kind: "sc" });
    const t = createSafetyCarState([{ kind: "vsc", startLaps: 1, durationLaps: 0.8 }]);
    stepSafetyCar(t, { ...base, leaderLaps: 1 });
    expect(stepSafetyCar(t, { ...base, leaderLaps: 1.2, racing: false })).toEqual({ type: "green", kind: "vsc" });
    expect(safetyCarCapMs(t)).toBeNull();
  });
});

describe("closing up behind the leader", () => {
  it("gives a car a bonus that grows with the gap and is bounded", () => {
    expect(catchUpBonusMs(null)).toBe(0);
    expect(catchUpBonusMs(10)).toBe(0);
    expect(catchUpBonusMs(58)).toBe(10);
    expect(catchUpBonusMs(5000)).toBe(12);
  });
});

describe("gap to the car ahead", () => {
  it("measures to the nearest car in front by total distance, null for the leader", () => {
    const field = [
      { lapCount: 1, progressMeters: 100 },
      { lapCount: 1, progressMeters: 160 },
      { lapCount: 0, progressMeters: 900 },
      { lapCount: 2, progressMeters: 0 },
    ];
    expect(gapAheadMeters(field, 0, 1000)).toBe(60);
    expect(gapAheadMeters(field, 2, 1000)).toBe(200);
    expect(gapAheadMeters(field, 3, 1000)).toBeNull();
    expect(gapAheadMeters(field, 9, 1000)).toBeNull();
  });
});
