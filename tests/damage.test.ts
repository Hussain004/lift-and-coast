import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  applyLoadSensitiveFriction,
  createCarController,
} from "../lib/physics/vehicle";
import { MIN_DAMAGE_GRIP_FRACTION, applyImpactDamage } from "../lib/physics/damage";

describe("applyImpactDamage", () => {
  it("leaves grip unchanged for impacts below the damage threshold", () => {
    expect(applyImpactDamage(1, 0)).toBe(1);
    expect(applyImpactDamage(1, 1000)).toBe(1);
    expect(applyImpactDamage(0.8, 5000)).toBe(0.8);
  });

  it("reduces grip by a fixed fraction per hit above the threshold", () => {
    const afterOneHit = applyImpactDamage(1, 20000);
    expect(afterOneHit).toBeLessThan(1);
    expect(afterOneHit).toBeGreaterThan(MIN_DAMAGE_GRIP_FRACTION);
  });

  it("floors accumulated damage at MIN_DAMAGE_GRIP_FRACTION across repeated hits", () => {
    let grip = 1;
    for (let i = 0; i < 20; i++) {
      grip = applyImpactDamage(grip, 50000);
    }
    expect(grip).toBe(MIN_DAMAGE_GRIP_FRACTION);
  });
});

describe("applyLoadSensitiveFriction wires damage into live wheel friction", () => {
  it("reduces friction slip proportionally to the damage grip multiplier", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);

    applyLoadSensitiveFriction(controller, "high-downforce", 1, 1, 1);
    const undamagedSlip = controller.wheelFrictionSlip(0) ?? 0;

    applyLoadSensitiveFriction(controller, "high-downforce", 1, 1, 0.7);
    const damagedSlip = controller.wheelFrictionSlip(0) ?? 0;

    expect(damagedSlip).toBeCloseTo(undamagedSlip * 0.7, 5);
  });
});
