import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  BOOSTED_ENGINE_FORCE_CAP,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_ENGINE_FORCE,
  applyCarControls,
  applyLoadSensitiveFriction,
  createCarController,
  speedSensitiveSteerScale,
} from "../lib/physics/vehicle";
import {
  IDLE_RPM,
  createGearboxState,
  engineTorqueMultiplier,
  gearThrustFactor,
} from "../lib/physics/gearbox";

describe("speedSensitiveSteerScale", () => {
  it("gives full lock at a standstill and low speed", () => {
    expect(speedSensitiveSteerScale(0)).toBe(1);
    expect(speedSensitiveSteerScale(5)).toBe(1);
  });

  it("reduces lock progressively between the full-lock and min-lock speeds", () => {
    const at10 = speedSensitiveSteerScale(10);
    const at25 = speedSensitiveSteerScale(25);
    const at40 = speedSensitiveSteerScale(40);
    expect(at10).toBeLessThan(1);
    expect(at25).toBeLessThan(at10);
    expect(at40).toBeLessThan(at25);
  });

  it("floors out rather than reaching zero at high speed", () => {
    const scale = speedSensitiveSteerScale(45);
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeCloseTo(0.35, 5);
    // Going even faster should not reduce it further.
    expect(speedSensitiveSteerScale(200)).toBe(scale);
  });

  it("is symmetric for reversing (negative) speed", () => {
    expect(speedSensitiveSteerScale(-30)).toBe(speedSensitiveSteerScale(30));
  });
});

describe("applyCarControls wires the speed scale into the live wheel steering", () => {
  it("commands a smaller steering angle at high speed than at a standstill for the same input", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    applyCarControls(controller, { throttle: 0, brake: 0, steer: 1 }, 0, 1, 0, 0, true);
    const steeringAtStandstill = controller.wheelSteering(0) ?? 0;

    applyCarControls(controller, { throttle: 0, brake: 0, steer: 1 }, 0, 1, 0, 40, true);
    const steeringAtSpeed = controller.wheelSteering(0) ?? 0;

    expect(steeringAtStandstill).toBeGreaterThan(0);
    expect(steeringAtSpeed).toBeGreaterThan(0);
    expect(steeringAtSpeed).toBeLessThan(steeringAtStandstill);
  });
});

describe("applyCarControls caps Push-to-Pass boost at a safe ceiling", () => {
  it("clamps the boosted force but leaves unboosted throttle unchanged", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    // Gears are on (the same path production uses): at a standstill the
    // engine sits at idle rpm in 1st, so unboosted thrust is the full base
    // force scaled by the gearbox's torque curve and 1st-gear ratio.
    const gearbox = createGearboxState(true);
    const idleRpmThrust =
      DEFAULT_ENGINE_FORCE * engineTorqueMultiplier(IDLE_RPM) * gearThrustFactor(1);
    expect(idleRpmThrust).toBeLessThan(DEFAULT_ENGINE_FORCE);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      0,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false }
    );
    expect(controller.wheelEngineForce(2)).toBeCloseTo(idleRpmThrust, 1);

    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1.6,
      0,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false }
    );
    // The geared boost runs through the same verified safe ceiling.
    expect(controller.wheelEngineForce(2)).toBeCloseTo(BOOSTED_ENGINE_FORCE_CAP, 0);
  });
});

describe("applyLoadSensitiveFriction wires tire compound wear into live wheel friction", () => {
  it("scales friction slip down proportionally to a degraded compound multiplier", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    // Compares the ratio between two calls rather than anchoring to
    // BASE_FRICTION_SLIP directly - wheelSuspensionForce() before any
    // physics step has run isn't STATIC_WHEEL_LOAD_N (the documented
    // fallback only covers a null/undefined reading, not an actual 0N),
    // so the load-sensitivity term's own contribution here is whatever it
    // is; only the compound multiplier's effect on top of that is this
    // test's actual concern.
    applyLoadSensitiveFriction(controller, "high-downforce", 1);
    const freshSlip = controller.wheelFrictionSlip(0) ?? 0;

    applyLoadSensitiveFriction(controller, "high-downforce", 0.85);
    const wornSlip = controller.wheelFrictionSlip(0) ?? 0;

    expect(wornSlip).toBeCloseTo(freshSlip * 0.85, 5);
  });
});
