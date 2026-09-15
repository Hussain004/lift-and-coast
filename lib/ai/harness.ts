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
  OFF_TRACK_RESET_METERS,
  WORLD_EDGE_RESET_METERS,
  applyCarControls,
  applyDragImpulse,
  applyLoadSensitiveFriction,
  computeSignedForwardSpeed,
  computeStabilizingTorque,
  createCarController,
} from "../physics/vehicle";
import { computeDownforceN, type AeroMode } from "../physics/aero";
import { buildRibbonGeometry, GRASS_BELOW_TRACK_METERS } from "../tracks/mesh";
import { checkTrackLimits } from "../tracks/trackLimits";
import type { TrackData } from "../tracks/types";

export interface DriveInputPlan {
  throttle: number;
  brake: number;
  steer: number;
}

/** Live chassis state, passed to a closed-loop input function each step. */
export interface DriveState {
  x: number;
  z: number;
  yawRad: number;
  speedMs: number;
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
  /** Defaults to "high-downforce" - the identity aero mode (see aero.ts). */
  aeroMode?: AeroMode;
  /**
   * Push-to-Pass's engine force multiplier (see energy.ts) - defaults to 1
   * (no boost). Matches Car.tsx: applied via applyCarControls, not by
   * pre-multiplying engineForce, since applyCarControls clamps the boosted
   * result to a safe ceiling (see BOOSTED_ENGINE_FORCE_CAP in vehicle.ts).
   */
  boostMultiplier?: number;
  /**
   * Traction control assist (see tractionControlThrottleScale in
   * vehicle.ts) - defaults to true, matching Car.tsx's own default-on
   * assist state.
   */
  tractionControlEnabled?: boolean;
  /**
   * Per-step off-track distance (meters, 0 = on track), only called when
   * `track` is given. StabilityResult only keeps the single worst value
   * over the whole run - this is for tuning scripts/tests that need the
   * full timeline (e.g. counting how many separate off-track excursions
   * happened, not just how bad the worst one was).
   */
  onStep?: (elapsedSeconds: number, offTrackMeters: number) => void;
}

export interface StabilityResult {
  maxTiltRad: number;
  finalSpeedMs: number;
  /** Net straight-line displacement from start to end position. */
  distanceMeters: number;
  /**
   * Total path length actually driven, accumulated from real position
   * deltas each step - not the same as distanceMeters (net displacement)
   * once a run covers a large enough fraction of a closed-loop track that
   * the two diverge (e.g. a long run that laps back toward its own start
   * has small displacement despite having driven a real distance). Immune
   * to any speed-reading quirks by construction, since it never reads a
   * "speed" value at all, only positions.
   */
  distanceTraveledMeters: number;
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
  /**
   * Largest single-timestep change in tilt, in radians. A smooth suspension
   * response changes by a small fraction of this per 1/60s step even during
   * hard cornering or braking - a much larger single-step jump means an
   * actual discontinuity (e.g. a wheel crossing a real geometry step), not
   * gradual physics. Caught the grass/track height mismatch bug.
   */
  maxTiltStepRad: number;
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
 * speed, then steer) by passing a function of elapsed seconds, or react to
 * the car's own live position/heading/speed (e.g. a path-following AI
 * controller) via that function's second argument - a fixed plan or a
 * function that ignores the second argument both still work unchanged.
 */
export async function simulateDrive(
  seconds: number,
  input: DriveInputPlan | ((elapsedSeconds: number, state: DriveState) => DriveInputPlan),
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
    // to do with the vehicle. Surface height derived from
    // GRASS_BELOW_TRACK_METERS - see its definition for why that gap.
    const groundBody = world.createRigidBody(
      RAPIER_MOD.RigidBodyDesc.fixed().setTranslation(0, -(0.5 + GRASS_BELOW_TRACK_METERS), 0)
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
  const startRotation = chassis.rotation();
  const startYaw = yawFromRotation(startRotation);

  let maxTilt = 0;
  let maxOffTrackMeters = 0;
  let maxTiltStep = 0;
  let previousTilt: number | null = null;
  let distanceTraveledMeters = 0;
  let previousStepPos = startPos;
  const steps = Math.round(seconds / timestep);
  const aeroMode = options.aeroMode ?? "high-downforce";
  for (let i = 0; i < steps; i++) {
    // Matches Car.tsx: past this distance off-track, snap back to the start
    // line rather than let the car keep going - a long enough straight-line
    // run off-course eventually crosses the finite ground plane's edge and
    // crashes the physics engine entirely (found via this harness). Also
    // matches Car.tsx's absolute-distance-from-origin backstop
    // (WORLD_EDGE_RESET_METERS) - see its definition for why the ribbon-
    // distance check alone isn't enough.
    if (options.track) {
      const p = chassis.translation();
      if (
        checkTrackLimits(options.track, p.x, p.z).distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
        Math.hypot(p.x, p.z) > WORLD_EDGE_RESET_METERS
      ) {
        chassis.setTranslation(startPos, true);
        chassis.setRotation(startRotation, true);
        chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
        chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        // The reset itself is an intentional tilt discontinuity and an
        // intentional position teleport, not a physics bug or real distance
        // driven - don't let either register as one.
        previousTilt = null;
        previousStepPos = startPos;
      }
    }
    const preStepPos = chassis.translation();
    const preStepRot = chassis.rotation();
    const preStepYaw = yawFromRotation(preStepRot);
    const stepInput = getInput(i * timestep, {
      x: preStepPos.x,
      z: preStepPos.z,
      yawRad: preStepYaw,
      // Not controller.currentVehicleSpeed() - see
      // computeSignedForwardSpeed's own comment for why that reads the
      // wrong sign at sustained high speed on the real trimesh, which
      // would feed garbage into a closed-loop controller like an AI's path
      // follower. applyCarControls' own currentSpeedMs argument below is
      // left as controller.currentVehicleSpeed() - changing that would
      // shift behavior for every existing scripted-input stability test in
      // this suite, not just this new closed-loop use.
      speedMs: computeSignedForwardSpeed(chassis.linvel(), preStepYaw),
    });
    applyCarControls(
      controller,
      stepInput,
      options.engineForce,
      options.boostMultiplier ?? 1,
      options.brakeForce,
      controller.currentVehicleSpeed(),
      options.tractionControlEnabled ?? true
    );
    applyLoadSensitiveFriction(controller, aeroMode);
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
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), aeroMode);
    chassis.applyImpulse({ x: 0, y: -downforceN * timestep, z: 0 }, true);
    applyDragImpulse(chassis, aeroMode, timestep);

    world.step();
    const tilt = tiltFromUpright(chassis.rotation());
    maxTilt = Math.max(maxTilt, tilt);
    if (previousTilt !== null) {
      maxTiltStep = Math.max(maxTiltStep, Math.abs(tilt - previousTilt));
    }
    previousTilt = tilt;
    const stepEndPos = chassis.translation();
    distanceTraveledMeters += Math.hypot(
      stepEndPos.x - previousStepPos.x,
      stepEndPos.z - previousStepPos.z
    );
    previousStepPos = stepEndPos;
    if (options.track) {
      const pos = chassis.translation();
      const offTrackMeters = checkTrackLimits(options.track, pos.x, pos.z).distanceFromEdgeMeters;
      maxOffTrackMeters = Math.max(maxOffTrackMeters, offTrackMeters);
      options.onStep?.(i * timestep, offTrackMeters);
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
    distanceTraveledMeters,
    maxOffTrackMeters,
    netYawChangeRad,
    maxTiltStepRad: maxTiltStep,
  };
}
