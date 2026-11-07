import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  applyCarControls,
  createCarController,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  BOOSTED_ENGINE_FORCE_CAP,
} from "../lib/physics/vehicle";
import {
  ABS_DEADBAND,
  ABS_MIN_SCALE,
  ABS_RELEASE_STEP_PER_TICK,
  ABS_TARGET_SLIP,
  TC_CUT_SLIP_START,
  TC_MIN_SCALE,
  absReleaseStep,
  createSlipTracker,
  slipRatioFor,
  tractionCutForSlip,
} from "../lib/physics/slipAssist";
import {
  createGearboxState,
  rpmForGear,
  engineTorqueMultiplier,
  gearThrustFactor,
} from "../lib/physics/gearbox";

describe("slipRatioFor", () => {
  it("reports 0 for surface speed matched to ground speed", () => {
    expect(slipRatioFor(30, 30)).toBe(0);
    expect(slipRatioFor(-30, -30)).toBe(0); // reverse rolling
  });

  it("is 0 below the reference speed, where the ratio is meaningless", () => {
    expect(slipRatioFor(1, 1)).toBe(0);
    expect(slipRatioFor(0, 2.9)).toBe(0);
  });

  it("is positive for wheelspin, negative for lockup, mirrored in reverse", () => {
    expect(slipRatioFor(45, 30)).toBeGreaterThan(0);
    expect(slipRatioFor(0, 30)).toBeCloseTo(-1, 6);
    expect(slipRatioFor(-45, -30)).toBeGreaterThan(0); // spin while reversing
    expect(slipRatioFor(0, -30)).toBeCloseTo(-1, 6); // locked while reversing
  });
});

describe("tractionCutForSlip", () => {
  it("keeps full power at or below the peak slip", () => {
    expect(tractionCutForSlip(TC_CUT_SLIP_START, 60)).toBe(1);
    expect(tractionCutForSlip(0.05, 60)).toBe(1);
  });

  it("cuts to TC_MIN_SCALE at deep spin, monotonically between", () => {
    expect(tractionCutForSlip(0.4, 60)).toBeCloseTo(TC_MIN_SCALE, 6);
    expect(tractionCutForSlip(1, 60)).toBeCloseTo(TC_MIN_SCALE, 9);
    const mid = tractionCutForSlip((TC_CUT_SLIP_START + 0.4) / 2, 60);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(TC_MIN_SCALE);
  });

  it("softens for standing starts, reaching full authority from 12 m/s", () => {
    const deepSpin = 0.5;
    const launch = tractionCutForSlip(deepSpin, 4);
    const pace = tractionCutForSlip(deepSpin, 40);
    expect(launch).toBeGreaterThan(pace);
    expect(pace).toBeCloseTo(TC_MIN_SCALE, 5);
  });

  it("never goes below TC_MIN_SCALE, however insane the slip", () => {
    expect(tractionCutForSlip(5, 200)).toBeCloseTo(TC_MIN_SCALE, 9);
  });
});

describe("absReleaseStep (per-tick ABS modulation)", () => {
  it("releases pressure on a locked wheel, one step per tick, floored at ABS_MIN_SCALE", () => {
    expect(absReleaseStep(-0.5, 1)).toBeCloseTo(1 - ABS_RELEASE_STEP_PER_TICK, 9);
    let release = 1;
    for (let i = 0; i < 60; i++) release = absReleaseStep(-1, release);
    expect(release).toBe(ABS_MIN_SCALE);
  });

  it("holds pressure inside the deadband (hovering at peak grip, not slamming off)", () => {
    // ABS_TARGET_SLIP = -0.1: -0.08 is above target but inside the deadband.
    expect(absReleaseStep(-0.08, 0.6)).toBe(0.6);
  });

  it("recovers pressure when the wheel is rolling comfortably again", () => {
    expect(absReleaseStep(0.2, 0.4)).toBeGreaterThan(0.4);
    expect(absReleaseStep(0.2, 1)).toBe(1); // capped at full
    expect(absReleaseStep(ABS_TARGET_SLIP + ABS_DEADBAND + 1e-4, 0.5)).toBeGreaterThan(0.5);
  });
});

function fakeAngleSource() {
  const angles = [0, 0, 0, 0];
  return {
    source: { wheelRotation: (i: number): number | null => angles[i] },
    advance(deltaRad: number) {
      for (const i of angles.keys()) angles[i] += deltaRad;
    },
    set(i: number, value: number) {
      angles[i] = value;
    },
    angles,
  };
}

describe("createSlipTracker", () => {
  it("zeros on the first tick (no angular history yet)", () => {
    const fake = fakeAngleSource();
    const tracker = createSlipTracker();
    const estimate = tracker.update(fake.source, 40, 1 / 60);
    expect(estimate.perWheel).toEqual([0, 0, 0, 0]);
    expect(estimate.absRelease).toEqual([1, 1, 1, 1]);
  });

  it("reports matched rolling as zero slip", () => {
    const fake = fakeAngleSource();
    const tracker = createSlipTracker();
    const dt = 1 / 60;
    const v = 30;
    tracker.update(fake.source, v, dt);
    // 30 m/s over 0.34 m radius = 88.235 rad/s -> 1.47 rad per tick.
    fake.advance((v / 0.34) * dt);
    const estimate = tracker.update(fake.source, v, dt);
    for (const slip of estimate.perWheel) expect(slip).toBeCloseTo(0, 6);
    expect(estimate.absRelease).toEqual([1, 1, 1, 1]); // nothing locked, no modulation
  });

  it("reports a spun wheel as positive slip and a locked wheel as -1", () => {
    const fake = fakeAngleSource();
    const tracker = createSlipTracker();
    const dt = 1 / 60;
    const v = 30;
    tracker.update(fake.source, v, dt);
    fake.advance(((v / 0.34) * dt) * 2.2);
    const spun = tracker.update(fake.source, v, dt);
    expect(spun.perWheel[0]).toBeGreaterThan(0.1);
    expect(spun.absRelease[0]).toBe(1); // spin does not touch ABS

    const locked = fakeAngleSource();
    const tracker2 = createSlipTracker();
    tracker2.update(locked.source, v, dt);
    const still = tracker2.update(locked.source, v, dt); // angles never move
    expect(still.perWheel[1]).toBeCloseTo(-1, 5);
    expect(still.absRelease[1]).toBeLessThan(1); // locked: pressure eased
    // After enough locked ticks, pressure bottoms out at the floor.
    for (let i = 0; i < 20; i++) tracker2.update(locked.source, v, dt);
    expect(tracker2.snapshot().absRelease[1]).toBe(ABS_MIN_SCALE);
  });

  it("is sign-consistent in reverse", () => {
    const fake = fakeAngleSource();
    const tracker = createSlipTracker();
    const dt = 1 / 60;
    const v = -30;
    tracker.update(fake.source, v, dt);
    fake.advance(-((Math.abs(v) / 0.34) * dt));
    const estimate = tracker.update(fake.source, v, dt);
    for (const slip of estimate.perWheel) expect(slip).toBeCloseTo(0, 6);
  });
});

async function makeController() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
  return createCarController(RAPIER, world, chassis);
}

function legacyCommand(currentSpeedMs: number, gear: number): number {
  return Math.min(
    DEFAULT_ENGINE_FORCE * engineTorqueMultiplier(rpmForGear(currentSpeedMs, gear)) * gearThrustFactor(gear),
    BOOSTED_ENGINE_FORCE_CAP
  );
}

describe("applyCarControls with the SlipAssist bundle", () => {
  it("cuts engine force on a spinning driven wheel, proportionally to TC authority", async () => {
    // Monkey-patch wheelRotation: rear wheels spinning at 2.2x ground speed.
    const controller = await makeController();
    const speed = 40;
    const radius = 0.34;
    const wheelOmega = (speed / radius) * 2.2; // spin harder than ground
    const angles = [0, 0, 0, 0];
    const angularPerTick = (wheelOmega * 1) / 60;
    (controller as unknown as { wheelRotation: (i: number) => number | null }).wheelRotation =
      (i: number) => angles[i];
    const tracker = createSlipTracker();
    const source = { wheelRotation: (i: number) => angles[i] };
    tracker.update(source, speed, 1 / 60);
    // Simulate two ticks of spin-up so the estimate is populated.
    angles[2] += angularPerTick;
    angles[3] += angularPerTick;
    tracker.update(source, speed, 1 / 60);
    angles[2] += angularPerTick;
    angles[3] += angularPerTick;
    tracker.update(source, speed, 1 / 60);

    const gearbox = createGearboxState(false);
    gearbox.gear = 6;
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      speed,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true,
      { tracker, absEnabled: false, tractionEnabled: true }
    );
    const cmd = legacyCommand(speed, 6);
    expect(cmd).toBeGreaterThan(0);
    const forced = controller.wheelEngineForce(2) ?? 0;
    expect(forced).toBeLessThan(cmd);
    expect(forced).toBeLessThanOrEqual(cmd * 0.1); // deep spin: essentially cut
    expect(controller.wheelEngineForce(1)).toBe(0); // front engine force untouched
  });

  it("releases a locked wheel's brake through ABS while ABS is on, and leaves it alone when off", async () => {
    for (const absEnabled of [true, false]) {
      const controller = await makeController();
      const angles = [0, 0, 0, 0]; // fully locked wheels
      (controller as unknown as { wheelRotation: (i: number) => number | null }).wheelRotation =
        (i: number) => angles[i];
      const tracker = createSlipTracker();
      const source = { wheelRotation: (i: number) => angles[i] };
      // Enough locked ticks for the modulation law to bottom out at the floor.
      tracker.update(source, 40, 1 / 60);
      for (let i = 0; i < 12; i++) tracker.update(source, 40, 1 / 60);
      applyCarControls(
        controller,
        { throttle: 0, brake: 1, steer: 0 },
        DEFAULT_ENGINE_FORCE,
        1,
        DEFAULT_BRAKE_FORCE,
        40,
        true,
        { state: createGearboxState(false), shiftUp: false, shiftDown: false },
        false,
        false,
        { tracker, absEnabled, tractionEnabled: false }
      );
      if (absEnabled) {
        expect(controller.wheelBrake(2)).toBeCloseTo(DEFAULT_BRAKE_FORCE * ABS_MIN_SCALE, 3);
      } else {
        expect(controller.wheelBrake(2)).toBeCloseTo(DEFAULT_BRAKE_FORCE, 3);
      }
    }
  });
});
