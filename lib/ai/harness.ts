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
  applyLoadSensitiveFriction,
  computeStabilizingTorque,
  createCarController,
} from "../physics/vehicle";
import { buildRibbonGeometry } from "../tracks/mesh";
import type { TrackData } from "../tracks/types";

export interface DriveInputPlan {
  throttle: number;
  brake: number;
  steer: number;
}

export interface StabilityOptions {
  engineForce: number;
  brakeForce: number;
  stabilizeStrength: number;
  /**
   * Simulate on the actual track trimesh instead of a flat plane, spawning
   * at its real start position/heading. Without this the harness only ever
   * proves stability on an infinite flat cuboid, which the shipped game
   * never drives on - real trimesh contacts (per-triangle, jittery near
   * shared edges) are a different and stricter test.
   */
  track?: TrackData;
}

export interface StabilityResult {
  maxTiltRad: number;
  finalSpeedMs: number;
  distanceMeters: number;
  /**
   * How far past the track edge the car got, in meters (0 if it never left
   * the ribbon, or if no track was given). Lets a scenario assert it stayed
   * on the actual trimesh rather than recovering on the flat grass cuboid
   * next to it - a steer input hard enough to run off the ribbon spends
   * most of its time being validated against the same flat-plane case the
   * default (trackless) mode already covers, not real trimesh contact.
   */
  maxOffTrackMeters: number;
  /** Absolute heading change from start to end of the run, in radians. */
  netYawChangeRad: number;
}

// Brute-force nearest centerline point. Only runs inside the harness's own
// per-step loop (never on the shipped game's hot path), and 2946 points at
// 60 steps/sec is trivial for a test to chew through.
function distanceFromTrackEdge(
  track: TrackData,
  x: number,
  z: number
): number {
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < track.centerline.length; i++) {
    const [cx, , cz] = track.centerline[i];
    const distSq = (cx - x) ** 2 + (cz - z) ** 2;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  const halfWidth = track.width[nearestIdx] / 2;
  return Math.max(0, Math.sqrt(nearestDistSq) - halfWidth);
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

function yawFromRotation(rotation: {
  x: number;
  y: number;
  z: number;
  w: number;
}): number {
  const { x, y, z, w } = rotation;
  return Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z));
}

/**
 * Simulates a car under a control input for `seconds`, tracking how far it
 * tips (0 = upright) and how it moves. Runs on a large flat plane by
 * default, or on `options.track`'s real trimesh (spawned at its start
 * position/heading) when given. `input` can vary over time (e.g. build
 * speed, then steer) by passing a function of elapsed seconds instead of a
 * fixed plan.
 */
export async function simulateDrive(
  seconds: number,
  input: DriveInputPlan | ((elapsedSeconds: number) => DriveInputPlan),
  options: StabilityOptions
): Promise<StabilityResult> {
  const getInput = typeof input === "function" ? input : () => input;
  const RAPIER_MOD = await ensureRapierInit();
  const timestep = 1 / 60;
  const world = new RAPIER_MOD.World({ x: 0, y: -9.81, z: 0 });

  if (options.track) {
    // Matches Scene.tsx exactly: grass cuboid under everything plus the
    // track trimesh on top, so a car pushed off the ribbon (e.g. by hard
    // steering) lands on grass like it does in the real game, instead of
    // free-falling through a void and reading as a "flip" that has nothing
    // to do with the vehicle.
    const groundBody = world.createRigidBody(
      RAPIER_MOD.RigidBodyDesc.fixed().setTranslation(0, -0.55, 0)
    );
    world.createCollider(
      RAPIER_MOD.ColliderDesc.cuboid(1250, 0.5, 1250).setFriction(0.6),
      groundBody
    );

    const { positions, indices } = buildRibbonGeometry(options.track);
    const trackBody = world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed());
    world.createCollider(
      RAPIER_MOD.ColliderDesc.trimesh(positions, indices).setFriction(1.3),
      trackBody
    );
  } else {
    const groundBody = world.createRigidBody(
      RAPIER_MOD.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
    );
    world.createCollider(
      RAPIER_MOD.ColliderDesc.cuboid(1000, 0.5, 1000).setFriction(1.2),
      groundBody
    );
  }

  const spawn = options.track?.startPos ?? { x: 0, z: 0, headingRad: 0 };
  const chassisDesc = RAPIER_MOD.RigidBodyDesc.dynamic()
    .setTranslation(spawn.x, 1, spawn.z)
    .setRotation(new RAPIER_MOD.Quaternion(0, Math.sin(spawn.headingRad / 2), 0, Math.cos(spawn.headingRad / 2)))
    .setLinearDamping(LINEAR_DAMPING)
    .setAngularDamping(ANGULAR_DAMPING)
    .setCanSleep(false);
  const chassis = world.createRigidBody(chassisDesc);
  // Matches Car.tsx exactly: mass is set on the one chassis collider via
  // setMass, not setAdditionalMass on the body. They are not equivalent -
  // additional mass stacks on top of the collider's own density-derived
  // mass, so the harness was previously simulating a ~225.76kg car against
  // constants tuned for 220kg.
  world
    .createCollider(RAPIER_MOD.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis)
    .setMass(CHASSIS_MASS);

  const controller = createCarController(RAPIER_MOD, world, chassis);
  const startPos = chassis.translation();
  const startYaw = yawFromRotation(chassis.rotation());

  let maxTilt = 0;
  let maxOffTrackMeters = 0;
  const steps = Math.round(seconds / timestep);
  for (let i = 0; i < steps; i++) {
    const stepInput = getInput(i * timestep);
    applyCarControls(
      controller,
      stepInput,
      options.engineForce,
      options.brakeForce,
      controller.currentVehicleSpeed()
    );
    applyLoadSensitiveFriction(controller);
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
    if (options.track) {
      const pos = chassis.translation();
      maxOffTrackMeters = Math.max(
        maxOffTrackMeters,
        distanceFromTrackEdge(options.track, pos.x, pos.z)
      );
    }
  }

  const endPos = chassis.translation();
  const distanceMeters = Math.hypot(
    endPos.x - startPos.x,
    endPos.z - startPos.z
  );
  const endYaw = yawFromRotation(chassis.rotation());
  const netYawChangeRad = Math.abs(
    Math.atan2(Math.sin(endYaw - startYaw), Math.cos(endYaw - startYaw))
  );

  return {
    maxTiltRad: maxTilt,
    finalSpeedMs: controller.currentVehicleSpeed(),
    distanceMeters,
    maxOffTrackMeters,
    netYawChangeRad,
  };
}
