import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  applyLoadSensitiveFriction,
  createCarController,
} from "../lib/physics/vehicle";
import { computeSurfaceGripMultiplier } from "../lib/tracks/trackLimits";

describe("computeSurfaceGripMultiplier", () => {
  it("is 1 while on track (zero or negative distance from the edge)", () => {
    expect(computeSurfaceGripMultiplier(0)).toBe(1);
    expect(computeSurfaceGripMultiplier(-5)).toBe(1);
  });

  it("falls off smoothly past the edge, floored at the minimum", () => {
    const justOff = computeSurfaceGripMultiplier(1);
    const halfway = computeSurfaceGripMultiplier(2);
    const atFloor = computeSurfaceGripMultiplier(4);
    const wayOff = computeSurfaceGripMultiplier(100);

    expect(justOff).toBeLessThan(1);
    expect(halfway).toBeLessThan(justOff);
    expect(atFloor).toBeLessThan(halfway);
    expect(wayOff).toBe(atFloor);
    expect(atFloor).toBeGreaterThan(0);
  });
});

describe("applyLoadSensitiveFriction wires surface grip into live wheel friction", () => {
  it("reduces friction slip proportionally to the surface grip multiplier", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    applyLoadSensitiveFriction(controller, "high-downforce", 1, 1);
    const onTrackSlip = controller.wheelFrictionSlip(0) ?? 0;

    applyLoadSensitiveFriction(controller, "high-downforce", 1, 0.5);
    const offTrackSlip = controller.wheelFrictionSlip(0) ?? 0;

    expect(offTrackSlip).toBeCloseTo(onTrackSlip * 0.5, 5);
  });
});
