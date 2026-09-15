import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  applyCarControls,
  createCarController,
  tractionControlThrottleScale,
} from "../lib/physics/vehicle";
import { simulateDrive } from "../lib/ai/harness";

describe("tractionControlThrottleScale", () => {
  it("is always 1 when disabled, regardless of speed or steering", () => {
    expect(tractionControlThrottleScale(0, 1, false)).toBe(1);
    expect(tractionControlThrottleScale(5, 1, false)).toBe(1);
    expect(tractionControlThrottleScale(0, 0, false)).toBe(1);
  });

  it("is always 1 on a straight line (no steering input), even at zero speed", () => {
    expect(tractionControlThrottleScale(0, 0, true)).toBe(1);
    expect(tractionControlThrottleScale(5, 0.1, true)).toBe(1); // below the steer threshold
  });

  it("is always 1 above the low-speed threshold, even while steering", () => {
    expect(tractionControlThrottleScale(20, 1, true)).toBe(1);
  });

  it("caps throttle below the threshold speed while steering, ramping back to 1 as speed rises", () => {
    const atZero = tractionControlThrottleScale(0, 1, true);
    const atHalf = tractionControlThrottleScale(7.5, 1, true);
    const atThreshold = tractionControlThrottleScale(15, 1, true);

    expect(atZero).toBeLessThan(1);
    expect(atZero).toBeGreaterThan(0);
    expect(atHalf).toBeGreaterThan(atZero);
    expect(atHalf).toBeLessThan(1);
    expect(atThreshold).toBe(1);
  });

  it("is symmetric for reversing (negative) speed and opposite (negative) steer", () => {
    expect(tractionControlThrottleScale(-5, 1, true)).toBe(tractionControlThrottleScale(5, 1, true));
    expect(tractionControlThrottleScale(5, -1, true)).toBe(tractionControlThrottleScale(5, 1, true));
  });
});

describe("applyCarControls wires traction control into live wheel engine force", () => {
  it("reduces engine force when steering at low speed with TC on, but not with TC off", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 1 },
      DEFAULT_ENGINE_FORCE,
      1,
      0,
      0,
      true
    );
    const withTC = controller.wheelEngineForce(2) ?? 0;

    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 1 },
      DEFAULT_ENGINE_FORCE,
      1,
      0,
      0,
      false
    );
    const withoutTC = controller.wheelEngineForce(2) ?? 0;

    expect(withTC).toBeLessThan(withoutTC);
    expect(withoutTC).toBeCloseTo(DEFAULT_ENGINE_FORCE, 0);
  });

  it("does not touch engine force on a straight line regardless of the TC toggle", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      0,
      0,
      true
    );
    const withTC = controller.wheelEngineForce(2) ?? 0;

    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      0,
      0,
      false
    );
    const withoutTC = controller.wheelEngineForce(2) ?? 0;

    expect(withTC).toBeCloseTo(withoutTC, 5);
    expect(withTC).toBeCloseTo(DEFAULT_ENGINE_FORCE, 0);
  });
});

describe("traction control does not regress the tuned straight-line launch", () => {
  it("gives statistically identical acceleration with TC on vs off when driving straight", async () => {
    const withTC = await simulateDrive(
      3,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        tractionControlEnabled: true,
      }
    );
    const withoutTC = await simulateDrive(
      3,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        tractionControlEnabled: false,
      }
    );

    expect(withTC.finalSpeedMs).toBeCloseTo(withoutTC.finalSpeedMs, 5);
    expect(withTC.distanceMeters).toBeCloseTo(withoutTC.distanceMeters, 5);
  });
});
