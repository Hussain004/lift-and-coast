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
import { peakLongitudinalForceN } from "../lib/physics/tireModel";
import {
  createGearboxState,
  rpmForGear,
  engineTorqueMultiplier,
  gearThrustFactor,
  REVERSE_GEAR,
} from "../lib/physics/gearbox";

async function makeController() {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const chassis = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
  return createCarController(RAPIER, world, chassis);
}

/** Pins the controller's per-wheel suspension-force telemetry (the data the
 * open-diff ceiling is derived from), so the cap can be exercised at any load
 * balance without balancing an actual car. Mirrors the 0-glitch guard: a
 * reading of 0 means "unusable this tick", a large load means a planted wheel. */
function pinLoads(controller: RAPIER.DynamicRayCastVehicleController, loads: [number, number, number, number]) {
  (controller as unknown as { wheelSuspensionForce: (index: number) => number }).wheelSuspensionForce =
    (i: number): number => loads[i];
}

function legacyCommand(currentSpeedMs: number, gear: number): number {
  const engineForce = Math.min(
    DEFAULT_ENGINE_FORCE * engineTorqueMultiplier(rpmForGear(currentSpeedMs, gear)) * gearThrustFactor(gear),
    BOOSTED_ENGINE_FORCE_CAP
  );
  return gear === REVERSE_GEAR ? -engineForce : engineForce;
}

describe("openDiffPairCeilingN via applyCarControls", () => {
  it("caps both driven wheels to the weak wheel's grip ceiling", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 2;
    // Inside wheel (2, left rear) nearly unloaded, outside (3) planted.
    pinLoads(controller, [600, 600, 300, 24000]);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true
    );
    const ceiling = peakLongitudinalForceN(300);
    const cmd = legacyCommand(0, 2);
    expect(cmd).toBeGreaterThan(ceiling); // otherwise the test proves nothing
    expect(controller.wheelEngineForce(2)).toBeCloseTo(ceiling, 3);
    expect(controller.wheelEngineForce(3)).toBeCloseTo(ceiling, 3);
  });

  it("leaves a full-throttle command alone when both driven wheels are planted", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 2;
    pinLoads(controller, [600, 600, 8000, 8000]);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true
    );
    const cmd = legacyCommand(0, 2);
    expect(peakLongitudinalForceN(8000)).toBeGreaterThan(cmd);
    expect(controller.wheelEngineForce(2)).toBeCloseTo(cmd, 3);
    expect(controller.wheelEngineForce(3)).toBeCloseTo(cmd, 3);
  });

  it("falls back to the unsplit command when a wheel's load glitches to zero", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 2;
    // The documented 2-3 step wheelSuspensionForce glitch: one driven wheel
    // reads exactly 0 while still reporting contact. Commanding zero force
    // in that tick would stutter the driveline.
    pinLoads(controller, [0, 0, 0, 24000]);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true
    );
    const cmd = legacyCommand(0, 2);
    expect(controller.wheelEngineForce(2)).toBeCloseTo(cmd, 3);
    expect(controller.wheelEngineForce(3)).toBeCloseTo(cmd, 3);
  });

  it("caps reverse thrust by the same weak wheel, keeping the direction", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = REVERSE_GEAR;
    pinLoads(controller, [600, 600, 300, 24000]);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true
    );
    const ceiling = peakLongitudinalForceN(300);
    expect(controller.wheelEngineForce(2)).toBeCloseTo(-ceiling, 3);
    expect(controller.wheelEngineForce(3)).toBeCloseTo(-ceiling, 3);
  });

  it("stamps positive command with positive cap - signs stay consistent", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 5;
    pinLoads(controller, [600, 600, 9000, 9000]);
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      65,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      false,
      true
    );
    expect(controller.wheelEngineForce(2)).toBeGreaterThan(0);
    expect(controller.wheelEngineForce(3)).toBeGreaterThan(0);
  });

  it("never raises thrust above what the caller commanded", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 2;
    // Any load balance, at full throttle: the cap can only lower force.
    for (const [a, b] of [
      [300, 24000],
      [8000, 8000],
      [24000, 300],
      [100, 100],
    ] as const) {
      pinLoads(controller, [600, 600, a, b]);
      applyCarControls(
        controller,
        { throttle: 1, brake: 0, steer: 0 },
        DEFAULT_ENGINE_FORCE,
        1,
        DEFAULT_BRAKE_FORCE,
        0,
        true,
        { state: gearbox, shiftUp: false, shiftDown: false },
        false,
        true
      );
      const cmd = legacyCommand(0, 2);
      for (const i of [2, 3]) {
        expect(Math.abs(controller.wheelEngineForce(i) ?? 0)).toBeLessThanOrEqual(Math.abs(cmd) + 1e-6);
      }
    }
  });

  it("flag omitted: command is bit-identical to the legacy path", async () => {
    const controller = await makeController();
    const gearbox = createGearboxState(false);
    gearbox.gear = 2;
    pinLoads(controller, [600, 600, 300, 24000]); // weak inside wheel, cap would bite
    applyCarControls(
      controller,
      { throttle: 1, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      0,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false }
    );
    expect(controller.wheelEngineForce(2)).toBeCloseTo(legacyCommand(0, 2), 3);
  });
});
