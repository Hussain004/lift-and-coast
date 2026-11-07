/**
 * The B4 steering additions (2026-11-07), kept in their own file so this
 * commit's history stays readable. The original control-settings storage
 * suite lives in tests/controlSettings.test.ts.
 */
import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  DEFAULT_SETTINGS,
  STEER_RETURN_RATE_MAX,
  STEER_RETURN_RATE_MIN,
  normalizeSettings,
} from "../lib/input/keyBindings";
import {
  applyCarControls,
  createCarController,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  MAX_STEER_ANGLE,
} from "../lib/physics/vehicle";

describe("normalizeSettings (B4 fields)", () => {
  it("fills every new field with its default from nothing", () => {
    const settings = normalizeSettings(undefined);
    expect(settings.speedSensitiveSteer).toBe(true);
    expect(settings.steerReturnRate).toBe(1);
    expect(settings.steeringIndicator).toBe(false);
    expect(settings).toEqual({ ...DEFAULT_SETTINGS });
  });

  it("clamps out-of-range values and drops garbage", () => {
    const settings = normalizeSettings({
      steerReturnRate: 9,
      speedSensitiveSteer: "not-a-bool",
      steeringIndicator: 1,
      steerSensitivity: 100,
    });
    expect(settings.steerReturnRate).toBe(STEER_RETURN_RATE_MAX);
    expect(settings.speedSensitiveSteer).toBe(true);
    expect(settings.steeringIndicator).toBe(false);
    expect(settings.steerSensitivity).toBe(2);
    const low = normalizeSettings({ steerReturnRate: 0.1 });
    expect(low.steerReturnRate).toBe(STEER_RETURN_RATE_MIN);
  });

  it("keeps an older stored object missing the new fields valid (forward repair)", () => {
    const settings = normalizeSettings({
      steerSensitivity: 1.2,
      invertSteering: true,
      defaultCompound: "soft",
    });
    expect(settings.speedSensitiveSteer).toBe(DEFAULT_SETTINGS.speedSensitiveSteer);
    expect(settings.steeringIndicator).toBe(DEFAULT_SETTINGS.steeringIndicator);
    expect(settings.steerReturnRate).toBe(DEFAULT_SETTINGS.steerReturnRate);
    expect(settings.steerSensitivity).toBe(1.2);
    expect(settings.invertSteering).toBe(true);
  });
});

async function steerAt(speedMs: number, speedSensitiveSteer?: boolean) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
  const controller = createCarController(RAPIER, world, chassis);
  applyCarControls(
    controller,
    { throttle: 0, brake: 0, steer: 1 },
    0,
    1,
    0,
    speedMs,
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    speedSensitiveSteer
  );
  return controller.wheelSteering(0) ?? 0;
}

describe("applyControls speedSensitiveSteer toggle (B4)", () => {
  it("narrows lock at speed by default (and for legacy callers)", async () => {
    const atRest = await steerAt(0);
    const atSpeed = await steerAt(40, undefined);
    expect(atRest).toBeCloseTo(MAX_STEER_ANGLE, 5);
    expect(atSpeed).toBeLessThan(atRest);
  });

  it("takes the full lock regardless of speed with the wheel-driver toggle off", async () => {
    const atRest = await steerAt(0, false);
    const atSpeed = await steerAt(40, false);
    expect(atSpeed).toBeCloseTo(atRest, 5);
    expect(atSpeed).toBeCloseTo(MAX_STEER_ANGLE, 5);
  });
});
