import { describe, expect, it } from "vitest";
import {
  AMBIENT_REFERENCE_C,
  BRAKE_TEMP_COLD_START_C,
  createBrakeTempModel,
} from "../lib/physics/brakeTemp";

describe("createBrakeTempModel (display-only disc meter)", () => {
  const idleStop = { brakeImpulsePerWheel: [0, 0, 0, 0] as [number, number, number, number] };

  it("starts with cold brakes in EQUILIBRIUM with nothing at all", () => {
    const model = createBrakeTempModel();
    const snap = model.snapshot();
    expect(snap.tempFrontC).toBe(BRAKE_TEMP_COLD_START_C);
    expect(snap.tempRearC).toBe(BRAKE_TEMP_COLD_START_C);
  });

  it("heats under braking and cools back down afterwards", () => {
    const model = createBrakeTempModel(BRAKE_TEMP_COLD_START_C);
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) {
      model.update({
        brakeImpulsePerWheel: [-25, -25, -14, -14],
        brake01: 1,
        forwardSpeedMs: 30,
        ambientC: AMBIENT_REFERENCE_C,
        dt,
      });
    }
    const hotFront = model.tempFrontC;
    const hotRear = model.tempRearC;
    expect(hotFront).toBeGreaterThan(BRAKE_TEMP_COLD_START_C);
    expect(hotFront).toBeGreaterThan(hotRear); // fronts take the bigger share

    const rearBefore = model.tempRearC;
    for (let i = 0; i < 60 * 60; i++) {
      model.update({ ...idleStop, brake01: 0, forwardSpeedMs: 60, ambientC: AMBIENT_REFERENCE_C, dt });
    }
    expect(model.tempRearC).toBeLessThan(rearBefore);
  });

  it("heats a locked wheel faster than a rolling one at the same pressure", () => {
    const rolling = createBrakeTempModel(400);
    const locked = createBrakeTempModel(400);
    const dt = 1 / 60;
    const base = { forwardSpeedMs: 0, ambientC: AMBIENT_REFERENCE_C, dt };
    for (let i = 0; i < 60; i++) {
      rolling.update({ ...base, brake01: 1, brakeImpulsePerWheel: [-25, -25, -25, -25], slipRatioPerWheel: [-0.1, -0.1, -0.1, -0.1] });
      locked.update({ ...base, brake01: 1, brakeImpulsePerWheel: [-25, -25, -25, -25], slipRatioPerWheel: [-0.9, -0.9, -0.9, -0.9] });
    }
    // Boost partially eaten by the hotter tyre's convective cooling; expect
    // a solid but below-1.6x gap, not an absolute 1.6 multiplication.
    expect(locked.tempFrontC - 400).toBeGreaterThan((rolling.tempFrontC - 400) * 1.4);
    expect(locked.tempFrontC).toBeGreaterThan(rolling.tempFrontC);
  });

  it("stays put on a NaN dt rather than poisoning the world", () => {
    const model = createBrakeTempModel(300);
    model.update({
      brakeImpulsePerWheel: [-25, -25, -25, -25],
      brake01: 1,
      forwardSpeedMs: 30,
      ambientC: 25,
      dt: Number.NaN,
    });
    expect(model.tempFrontC).toBe(300);
  });
});

describe("drive work is not brake work (regression)", () => {
  it("propulsion impulses on the driven wheels at full throttle do not heat the brakes", () => {
    const model = createBrakeTempModel(BRAKE_TEMP_COLD_START_C);
    const dt = 1 / 60;
    for (let i = 0; i < 300; i++) {
      model.update({
        brakeImpulsePerWheel: [0, 0, 25, 25],
        brake01: 0,
        forwardSpeedMs: 45,
        ambientC: AMBIENT_REFERENCE_C,
        dt,
      });
    }
    expect(model.tempRearC).toBeLessThanOrEqual(BRAKE_TEMP_COLD_START_C);
    expect(model.tempFrontC).toBeLessThanOrEqual(BRAKE_TEMP_COLD_START_C);
  });

  it("engine braking (retarding impulse, no pedal) is not counted as brake work", () => {
    const model = createBrakeTempModel(BRAKE_TEMP_COLD_START_C);
    const dt = 1 / 60;
    for (let i = 0; i < 120; i++) {
      model.update({
        brakeImpulsePerWheel: [0, 0, -12, -12],
        brake01: 0,
        forwardSpeedMs: 40,
        ambientC: AMBIENT_REFERENCE_C,
        dt,
      });
    }
    expect(model.tempRearC).toBeLessThanOrEqual(BRAKE_TEMP_COLD_START_C);
  });

  it("applies brake heat only to impulses opposing motion, not to drive impulses", () => {
    const model = createBrakeTempModel(BRAKE_TEMP_COLD_START_C);
    const dt = 1 / 60;
    // Ambient pinned to the cold start so the convective idle cannot
    // mask "no heat" by cooling the fronts past it.
    for (let i = 0; i < 120; i++) {
      model.update({
        brakeImpulsePerWheel: [10, 10, -12, -12],
        brake01: 1,
        forwardSpeedMs: 40,
        ambientC: BRAKE_TEMP_COLD_START_C,
        dt,
      });
    }
    const front = model.tempFrontC;
    const rear = model.tempRearC;
    expect(rear).toBeGreaterThan(front);
    expect(front).toBe(BRAKE_TEMP_COLD_START_C);
    expect(rear).toBeGreaterThan(BRAKE_TEMP_COLD_START_C);
  });
});
