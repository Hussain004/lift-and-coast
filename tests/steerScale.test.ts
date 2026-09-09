import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  applyCarControls,
  createCarController,
  speedSensitiveSteerScale,
} from "../lib/physics/vehicle";

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

    applyCarControls(controller, { throttle: 0, brake: 0, steer: 1 }, 0, 0, 0);
    const steeringAtStandstill = controller.wheelSteering(0) ?? 0;

    applyCarControls(controller, { throttle: 0, brake: 0, steer: 1 }, 0, 0, 40);
    const steeringAtSpeed = controller.wheelSteering(0) ?? 0;

    expect(steeringAtStandstill).toBeGreaterThan(0);
    expect(steeringAtSpeed).toBeGreaterThan(0);
    expect(steeringAtSpeed).toBeLessThan(steeringAtStandstill);
  });
});
