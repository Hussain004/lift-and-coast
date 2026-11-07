import { describe, expect, it } from "vitest";
import {
  AMBIENT_REFERENCE_C,
  BRAKE_COLD_FULL_C,
  BRAKE_COLD_MIN_EFFECT,
  BRAKE_FADE_END_C,
  BRAKE_FADE_MIN_EFFECT,
  BRAKE_FADE_START_C,
  BRAKE_TEMP_COLD_START_C,
  brakeEffectivenessForTemp,
  brakeFadeForTemp,
  createBrakeTempModel,
} from "../lib/physics/brakeTemp";

describe("brakeEffectivenessForTemp", () => {
  it("rides the cold-bite ramp up to full bite", () => {
    expect(brakeEffectivenessForTemp(BRAKE_TEMP_COLD_START_C)).toBeCloseTo(BRAKE_COLD_MIN_EFFECT, 9);
    expect(brakeEffectivenessForTemp(BRAKE_COLD_FULL_C)).toBe(1);
    expect(brakeEffectivenessForTemp((BRAKE_TEMP_COLD_START_C + BRAKE_COLD_FULL_C) / 2)).toBeGreaterThan(BRAKE_COLD_MIN_EFFECT);
    expect(brakeEffectivenessForTemp((BRAKE_TEMP_COLD_START_C + BRAKE_COLD_FULL_C) / 2)).toBeLessThan(1);
  });

  it("holds full bite across the working window", () => {
    expect(brakeEffectivenessForTemp(400)).toBe(1);
    expect(brakeEffectivenessForTemp(BRAKE_FADE_START_C)).toBe(1);
  });

  it("fades past the threshold, bottoming out at the floor", () => {
    expect(brakeEffectivenessForTemp(BRAKE_FADE_END_C)).toBe(BRAKE_FADE_MIN_EFFECT);
    expect(brakeEffectivenessForTemp(BRAKE_FADE_END_C + 400)).toBe(BRAKE_FADE_MIN_EFFECT);
    const mid = brakeEffectivenessForTemp((BRAKE_FADE_START_C + BRAKE_FADE_END_C) / 2);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(BRAKE_FADE_MIN_EFFECT);
  });

  it("is monotone through both ramps", () => {
    let prev = brakeEffectivenessForTemp(0);
    for (let t = 20; t <= BRAKE_COLD_FULL_C + 40; t += 10) {
      const eff = brakeEffectivenessForTemp(t);
      expect(eff).toBeGreaterThanOrEqual(prev);
      prev = eff;
    }
    prev = 1;
    for (let t = BRAKE_FADE_START_C; t <= BRAKE_FADE_END_C; t += 10) {
      const eff = brakeEffectivenessForTemp(t);
      expect(eff).toBeLessThanOrEqual(prev);
      prev = eff;
    }
  });
});

describe("brakeFadeForTemp", () => {
  it("is 0 inside the working window and 1 at/past the fade floor", () => {
    expect(brakeFadeForTemp(400)).toBe(0);
    expect(brakeFadeForTemp(BRAKE_FADE_END_C)).toBe(1);
    expect(brakeFadeForTemp(BRAKE_FADE_END_C + 500)).toBe(1);
  });
});

describe("createBrakeTempModel", () => {
  const idleStop = { brakeImpulsePerWheel: [0, 0, 0, 0] as [number, number, number, number] };

  it("starts with cold brakes that are not fully bitten", () => {
    const model = createBrakeTempModel();
    const snap = model.snapshot();
    expect(snap.tempFrontC).toBe(BRAKE_TEMP_COLD_START_C);
    expect(snap.tempRearC).toBe(BRAKE_TEMP_COLD_START_C);
    for (const eff of snap.effectiveness) expect(eff).toBeLessThan(1);
    expect(snap.effectiveness[0]).toBeCloseTo(BRAKE_COLD_MIN_EFFECT, 9);
    expect(snap.fade01).toBe(0);
  });

  it("heats under braking and cools back down afterwards", () => {
    const model = createBrakeTempModel(BRAKE_TEMP_COLD_START_C);
    const dt = 1 / 60;
    // Two seconds of one firm stop on all four wheels.
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
    // At 60 m/s the airflow envelope cools fastest; still time to come down.
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
    // Heating boosts lockup-rate wheel heating, though part of the boost is
    // spent competing with the stronger convective cooling a hotter tyre sees;
    // expect a solid but below-1.6x gap, not an absolute 1.6 multiplication.
    expect(locked.tempFrontC - 400).toBeGreaterThan((rolling.tempFrontC - 400) * 1.4);
    expect(locked.tempFrontC).toBeGreaterThan(rolling.tempFrontC);
  });

  it("reports faded brakes via snapshot and stops helping an already-red brake", () => {
    // Heat the model deep into the fade range with repeated stops.
    const model = createBrakeTempModel(600);
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 30; i++) {
      model.update({
        brakeImpulsePerWheel: [-25, -25, -25, -25],
        brake01: 1,
        forwardSpeedMs: 12,
        ambientC: 25,
        dt,
      });
      if (model.tempFrontC > 1100) break;
    }
    const snap = model.snapshot();
    expect(snap.fade01).toBeGreaterThan(0.5);
    for (const eff of snap.effectiveness) expect(eff).toBeLessThan(1);
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
      // What a driven axle reads under power: positive impulses. No brake
      // pedal, no brake heat - under any circumstances.
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
      // Coasting under engine braking: negative impulses, brake pedal off.
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
    for (let i = 0; i < 120; i++) {
      // Pedal applied, mixed work: fronts push the car forward (propulsion
      // impulse sign), rears hold it back (brake work sign). The brakes
      // only ever claim the rears; fronts stay exactly where they started.
      // Ambient pinned to the cold start so the convective idle cannot
      // mask "no heat" by cooling the fronts past it.
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
