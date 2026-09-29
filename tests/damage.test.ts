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

import {
  applyComponentDamage,
  classifyHit,
  createDamageState,
  damageAggregate,
  damageDownforceScale,
  damageRepairSeconds,
  damageWheelGrips,
  isDamaged,
  MIN_PART_HEALTH,
} from "../lib/physics/damage";

describe("component damage", () => {
  it("a front hit breaks the front wing and only front grip suffers", () => {
    const d = createDamageState();
    expect(applyComponentDamage(d, "front", 25000, "simulation")).toBe(true);
    expect(d.frontWing).toBeLessThan(1);
    expect(d.rearWing).toBe(1);
    const g = damageWheelGrips(d);
    expect(g[0]).toBeLessThan(g[2]);
    expect(g[0]).toBe(g[1]);
  });

  it("classifies hits from the direction of the force on the car", () => {
    // A wall pushes a car that ran into it backwards: that is the nose.
    expect(classifyHit({ forward: -0.9, right: 0.1, up: 0 })).toBe("front");
    expect(classifyHit({ forward: 0.9, right: 0.1, up: 0 })).toBe("rear");
    expect(classifyHit({ forward: 0.1, right: 0.9, up: 0 })).toBe("side");
    expect(classifyHit({ forward: 0.1, right: 0.1, up: 0.95 })).toBe("floor");
  });

  it("ignores soft contact, Off mode, and halves the damage in Reduced", () => {
    const d = createDamageState();
    expect(applyComponentDamage(d, "front", 5000, "simulation")).toBe(false);
    expect(applyComponentDamage(d, "front", 50000, "off")).toBe(false);
    expect(isDamaged(d)).toBe(false);
    const full = createDamageState();
    const half = createDamageState();
    applyComponentDamage(full, "front", 20000, "simulation");
    applyComponentDamage(half, "front", 20000, "reduced");
    expect(1 - half.frontWing).toBeCloseTo((1 - full.frontWing) / 2, 5);
  });

  it("never drops a part below its floor, never lifts a grip above 1x, and only Simulation punctures", () => {
    const d = createDamageState();
    for (let i = 0; i < 30; i++) applyComponentDamage(d, i % 2 ? "front" : "side", 80000, "simulation", i);
    expect(d.frontWing).toBe(MIN_PART_HEALTH);
    expect(d.puncture).toBeGreaterThanOrEqual(0);
    for (const g of damageWheelGrips(d)) {
      expect(g).toBeLessThanOrEqual(1);
      expect(g).toBeGreaterThan(0.2);
    }
    expect(damageDownforceScale(d)).toBeLessThan(1);
    expect(damageDownforceScale(d)).toBeGreaterThan(0.5);
    const reduced = createDamageState();
    applyComponentDamage(reduced, "front", 80000, "reduced");
    expect(reduced.puncture).toBe(-1);
  });

  it("the aggregate and the repair time follow the damage", () => {
    const d = createDamageState();
    expect(damageAggregate(d)).toBe(1);
    expect(damageRepairSeconds(d)).toBe(0);
    applyComponentDamage(d, "front", 40000, "simulation");
    expect(damageAggregate(d)).toBeLessThan(1);
    expect(damageRepairSeconds(d)).toBeGreaterThan(0);
  });
});
