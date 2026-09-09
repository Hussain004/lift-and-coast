/**
 * Headless vehicle stability harness (plan section 6: "automated headless
 * runner that hot-laps... without this, physics tuning is blind"). Runs the
 * exact same vehicle module the real game uses, in plain Node with no
 * browser/WebGL, so tuning changes can be checked by running tests instead
 * of manually driving and eyeballing it.
 */
import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import {
  ANGULAR_DAMPING,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  LINEAR_DAMPING,
  applyCarControls,
  computeStabilizingTorque,
  createCarController,
} from "../physics/vehicle";

export interface DriveInputPlan {
  throttle: number;
  brake: number;
  steer: number;
}

export interface StabilityOptions {
  engineForce: number;
  brakeForce: number;
  stabilizeStrength: number;
}

export interface StabilityResult {
  maxTiltRad: number;
  finalSpeedMs: number;
  distanceMeters: number;
}

let rapierReady: Promise<typeof RAPIER> | null = null;
function ensureRapierInit() {
  if (!rapierReady) rapierReady = RAPIER.init().then(() => RAPIER);
  return rapierReady;
}

function tiltFromUpright(rotation: {
  x: number;
  y: number;
  z: number;
  w: number;
}): number {
  const worldUp = new Vector3(0, 1, 0);
  const bodyUp = new Vector3(0, 1, 0).applyQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w)
  );
  return bodyUp.angleTo(worldUp);
}

/**
 * Simulates a car on a large flat plane under a constant control input for
 * `seconds`, tracking how far it tips (0 = upright) and how it moves.
 */
export async function simulateDrive(
  seconds: number,
  input: DriveInputPlan,
  options: StabilityOptions
): Promise<StabilityResult> {
  const RAPIER_MOD = await ensureRapierInit();
  const timestep = 1 / 60;
  const world = new RAPIER_MOD.World({ x: 0, y: -9.81, z: 0 });

  const groundBody = world.createRigidBody(
    RAPIER_MOD.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
  );
  world.createCollider(
    RAPIER_MOD.ColliderDesc.cuboid(500, 0.5, 500).setFriction(1.2),
    groundBody
  );

  const chassisDesc = RAPIER_MOD.RigidBodyDesc.dynamic()
    .setTranslation(0, 1, 0)
    .setLinearDamping(LINEAR_DAMPING)
    .setAngularDamping(ANGULAR_DAMPING)
    .setCanSleep(false)
    .setAdditionalMass(CHASSIS_MASS);
  const chassis = world.createRigidBody(chassisDesc);
  world.createCollider(
    RAPIER_MOD.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS),
    chassis
  );

  const controller = createCarController(RAPIER_MOD, world, chassis);
  const startPos = chassis.translation();

  let maxTilt = 0;
  const steps = Math.round(seconds / timestep);
  for (let i = 0; i < steps; i++) {
    applyCarControls(controller, input, options.engineForce, options.brakeForce);
    controller.updateVehicle(timestep);

    const torque = computeStabilizingTorque(
      chassis.rotation(),
      options.stabilizeStrength
    );
    if (torque[0] || torque[1] || torque[2]) {
      chassis.applyTorqueImpulse(
        {
          x: torque[0] * timestep,
          y: torque[1] * timestep,
          z: torque[2] * timestep,
        },
        true
      );
    }

    world.step();
    maxTilt = Math.max(maxTilt, tiltFromUpright(chassis.rotation()));
  }

  const endPos = chassis.translation();
  const distanceMeters = Math.hypot(
    endPos.x - startPos.x,
    endPos.z - startPos.z
  );

  return {
    maxTiltRad: maxTilt,
    finalSpeedMs: controller.currentVehicleSpeed(),
    distanceMeters,
  };
}
