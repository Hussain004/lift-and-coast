import { describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import {
  applyCarControls,
  applyDragImpulse,
  applyLoadSensitiveFriction,
  applyVehicleStabilityTorques,
  computeSignedForwardSpeed,
  createCarController,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  ENGINE_BRAKE_BASE_N,
  ENGINE_BRAKE_FULL_RAMP_SPEED_MS,
  ENGINE_BRAKE_IDLE_RAMP_START_MS,
  ENGINE_BRAKE_MAX_THROTTLE,
  engineBrakeForceN,
  LINEAR_DAMPING,
  ANGULAR_DAMPING,
} from "../lib/physics/vehicle";
import {
  GEAR_RATIOS,
  effectiveGearRatio,
  REVERSE_GEAR,
  createGearboxState,
  rpmForGear,
  engineTorqueMultiplier,
  gearThrustFactor,
  type GearboxState,
} from "../lib/physics/gearbox";
import { computeDownforceN } from "../lib/physics/aero";

describe("engineBrakeForceN", () => {
  it("is zero at a standstill and below the ramp start", () => {
    expect(engineBrakeForceN(0, 3)).toBe(0);
    expect(engineBrakeForceN(ENGINE_BRAKE_IDLE_RAMP_START_MS, 3)).toBe(0);
    expect(engineBrakeForceN(-ENGINE_BRAKE_IDLE_RAMP_START_MS, 3)).toBe(0);
  });

  it("is zero in reverse gear and out-of-range gears", () => {
    expect(engineBrakeForceN(40, REVERSE_GEAR)).toBe(0);
    expect(engineBrakeForceN(40, -1)).toBe(0);
    expect(engineBrakeForceN(40, GEAR_RATIOS.length + 1)).toBe(0);
  });

  it("spools up over the ramp window and is at full strength past it", () => {
    const base = engineBrakeForceN(ENGINE_BRAKE_FULL_RAMP_SPEED_MS, 1);
    expect(base).toBe(-ENGINE_BRAKE_BASE_N);
    expect(engineBrakeForceN(ENGINE_BRAKE_FULL_RAMP_SPEED_MS + 10, 1)).toBe(-ENGINE_BRAKE_BASE_N);
    const mid = Math.abs(engineBrakeForceN((ENGINE_BRAKE_IDLE_RAMP_START_MS + ENGINE_BRAKE_FULL_RAMP_SPEED_MS) / 2, 1));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(ENGINE_BRAKE_BASE_N);
  });

  it("is ratio-scaled down the gearbox: 1st strongest, monotonic through the box", () => {
    const inFirst = Math.abs(engineBrakeForceN(40, 1));
    expect(inFirst).toBeCloseTo(ENGINE_BRAKE_BASE_N, 6);
    let previous = inFirst;
    for (let gear = 2; gear <= GEAR_RATIOS.length; gear++) {
      const magnitude = Math.abs(engineBrakeForceN(40, gear));
      expect(magnitude).toBeLessThan(previous);
      expect(magnitude).toBeCloseTo(ENGINE_BRAKE_BASE_N * (effectiveGearRatio(gear) / GEAR_RATIOS[0]), 6);
      previous = magnitude;
    }
  });

  it("opposes the direction of rolling motion", () => {
    expect(engineBrakeForceN(40, 3)).toBeLessThan(0);
    expect(engineBrakeForceN(-40, 3)).toBeGreaterThan(0);
    expect(engineBrakeForceN(40, 3)).toBe(-engineBrakeForceN(-40, 3));
  });

  it("lets the top-gear final-drive trim participate", () => {
    const standard = Math.abs(engineBrakeForceN(40, GEAR_RATIOS.length, 1));
    const longer = Math.abs(engineBrakeForceN(40, GEAR_RATIOS.length, 1.05));
    expect(longer).toBeGreaterThan(standard);
    // And the trim is the same ratio multiplication the drive side gets.
    expect(longer).toBeCloseTo(standard * 1.05, 6);
  });
});

describe("applyCarControls wires engine braking into the driven wheels", () => {
  it("adds the signed retarder to the driven wheels only, on a closed throttle", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);
    const gearbox = createGearboxState(false);
    gearbox.gear = 4;

    applyCarControls(
      controller,
      { throttle: 0, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      true
    );
    // The rear (driven) wheels carry exactly the helper's force - compared
    // within float tolerance (the gearbox's normalized final drive differs
    // from a literal 1 at the 9th decimal), keeping the live path and the
    // unit tests on one code path rather than two tuned copies.
    expect(controller.wheelEngineForce(2)).toBeCloseTo(engineBrakeForceN(40, 4), 5);
    expect(controller.wheelEngineForce(2)).toBeLessThan(0);
    expect(controller.wheelEngineForce(3)).toBeCloseTo(engineBrakeForceN(40, 4), 5);
    // Front wheels are not driven, so they never engine-brake.
    expect(controller.wheelEngineForce(0) ?? 0).toBe(0);
    expect(controller.wheelEngineForce(1) ?? 0).toBe(0);
  });

  it("leaves every wheel force untouched when the flag is omitted (legacy callers)", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);
    const gearbox = createGearboxState(false);
    gearbox.gear = 1;

    applyCarControls(
      controller,
      { throttle: 0, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false }
    );
    expect(controller.wheelEngineForce(2)).toBe(0);
  });

  it("stays out of the way under real throttle", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);
    const gearbox = createGearboxState(false);
    gearbox.gear = 4;

    // Just past the closed-throttle gate: thrust owns the driven wheels.
    applyCarControls(
      controller,
      { throttle: ENGINE_BRAKE_MAX_THROTTLE, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      true
    );
    const rpm = rpmForGear(40, 4);
    const expected = Math.min(
      DEFAULT_ENGINE_FORCE * ENGINE_BRAKE_MAX_THROTTLE * engineTorqueMultiplier(rpm) * gearThrustFactor(4),
      1750
    );
    expect(controller.wheelEngineForce(2)).toBeCloseTo(expected, 4);

    // And a zero-throttle tick above, in the same gear, is pure retardation.
    applyCarControls(
      controller,
      { throttle: 0, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      true
    );
    expect(controller.wheelEngineForce(2)).toBeLessThan(0);
  });

  it("stays off while the brake pedal is already down, however lightly", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);
    const gearbox = createGearboxState(false);
    gearbox.gear = 3;

    // A closed throttle WITH any brake travel is the validated braking
    // envelope (IMPROVEMENTS.md F5) - the retarder must not add rear
    // retarding torque there. Even a whisper of a brake leaves the wheels
    // doing only their validated job: zero engine force at zero throttle.
    applyCarControls(
      controller,
      { throttle: 0, brake: 0.05, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      true
    );
    expect(controller.wheelEngineForce(2)).toBe(0);
    expect(controller.wheelEngineForce(3)).toBe(0);
  });

  it("imposes nothing in reverse, however it is requested", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0).setAdditionalMass(CHASSIS_MASS)
    );
    world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    const controller = createCarController(RAPIER, world, chassis);
    const gearbox = createGearboxState(false);
    gearbox.gear = REVERSE_GEAR;

    applyCarControls(
      controller,
      { throttle: 0, brake: 0, steer: 0 },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      40,
      true,
      { state: gearbox, shiftUp: false, shiftDown: false },
      true
    );
    expect(controller.wheelEngineForce(2)).toBe(0);
  });

  it("adds real coasting deceleration to a car rolling at speed", async () => {
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    const ground = RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(400, 0.5, 400).setFriction(1.3),
      world.createRigidBody(ground)
    );

    const makeCar = async (): Promise<{
      controller: RAPIER.DynamicRayCastVehicleController;
      body: RAPIER.RigidBody;
      gearbox: GearboxState;
    }> => {
      const chassisDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 1, 0)
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCanSleep(false);
      const body = world.createRigidBody(chassisDesc);
      world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), body).setMass(CHASSIS_MASS);
      const controller = createCarController(RAPIER, world, body);
      const gearbox = createGearboxState(false);
      return { controller, body, gearbox };
    };

    const dt = 1 / 60;
    const step = (
      car: { controller: RAPIER.DynamicRayCastVehicleController; body: RAPIER.RigidBody; gearbox: GearboxState },
      engineBrake: boolean
    ) => {
      applyCarControls(
        car.controller,
        { throttle: 0, brake: 0, steer: 0 },
        DEFAULT_ENGINE_FORCE,
        1,
        DEFAULT_BRAKE_FORCE,
        car.controller.currentVehicleSpeed(),
        true,
        { state: car.gearbox, shiftUp: false, shiftDown: false },
        engineBrake
      );
      applyLoadSensitiveFriction(car.controller, "high-downforce");
      car.controller.updateVehicle(dt);
      applyVehicleStabilityTorques(car.body, DEFAULT_STABILIZE_STRENGTH, dt);
      const downforceN = computeDownforceN(car.controller.currentVehicleSpeed(), "high-downforce");
      car.body.applyImpulse({ x: 0, y: -downforceN * dt, z: 0 }, true);
      applyDragImpulse(car.body, "high-downforce", dt);
      world.step();
    };

    const coastDecel = async (engineBrake: boolean): Promise<number> => {
      // A fresh car per measurement, so suspension history cannot couple runs.
      const car = await makeCar();
      car.gearbox.gear = 4;
      car.gearbox.auto = false;
      const seconds = 2;
      // At 40 m/s in 4th: the gear the throttle law would be in on a long
      // straight's overrun, and the case the constant above was measured on.
      for (let i = 0; i < 90; i++) {
        car.body.setLinvel({ x: 0, y: 0, z: -40 }, true);
        car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        step(car, engineBrake);
      }
      car.body.setLinvel({ x: 0, y: 0, z: -40 }, true);
      const startSpeed = Math.abs(computeSignedForwardSpeed(car.body.linvel(), 0));
      for (let i = 0; i < seconds * 60; i++) step(car, engineBrake);
      const endSpeed = Math.abs(computeSignedForwardSpeed(car.body.linvel(), 0));
      return (startSpeed - endSpeed) / seconds;
    };

    const without = await coastDecel(false);
    const withEB = await coastDecel(true);
    const delta = withEB - without;
    // Measured (see IMPROVEMENTS.md F5): the retarder at ENGINE_BRAKE_BASE_N
    // contributes around +0.9 m/s^2 of coast deceleration at 40 m/s in 4th -
    // a real, felt overrun, still ~5% of the brake force so validated braking
    // behaviour is untouched. The band is wide enough for physics jitter but
    // would catch the flag being unwired or the magnitude drifting badly.
    expect(delta).toBeGreaterThan(0.3);
    expect(delta).toBeLessThan(2.0);
  });
});
