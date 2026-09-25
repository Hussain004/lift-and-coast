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
  CAR_WHEELS,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  LINEAR_DAMPING,
  OFF_TRACK_RESET_METERS,
  applyCarControls,
  applyDragImpulse,
  applyKerbRideHeights,
  applyLoadSensitiveFriction,
  applySurfaceDragImpulse,
  computeSignedForwardSpeed,
  applyVehicleStabilityTorques,
  createCarController,
  wheelGroundPositions,
} from "../physics/vehicle";
import { computeDownforceN, type AeroMode } from "../physics/aero";
import { createGearboxState, gearboxSpeedMs, rpmForGear } from "../physics/gearbox";
import { buildRibbonGeometry } from "../tracks/mesh";
import { buildBarrierWallMesh } from "../tracks/structures";
import { buildTerrainGeometry } from "../tracks/terrain";
import { checkTrackLimits, worldEdgeResetMeters } from "../tracks/trackLimits";
import {
  meanSurfaceDrag,
  sampleSurface,
  wheelSurfaceGrips,
} from "../tracks/surfaces";
import type { TrackData } from "../tracks/types";

export interface DriveInputPlan {
  throttle: number;
  brake: number;
  steer: number;
  /**
   * Per-tick overrides for a closed-loop controller that varies these
   * itself (e.g. an AI switching aero mode/deploying Push-to-Pass by
   * track position - not wired into AICar.tsx yet, a first attempt at
   * that destabilized the AI and was reverted, see pathFollower.ts's own
   * comment on AIControls.zone) - falls back to the fixed
   * options.boostMultiplier/aeroMode when omitted, so every existing
   * scripted-input test (which never sets these) is unaffected.
   */
  boostMultiplier?: number;
  aeroMode?: AeroMode;
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
  /**
   * Include the barrier line's collider. Defaults to true, because that is
   * what the game does and a gate that runs without it validates a car that
   * can drive through walls the player cannot.
   *
   * Set false ONLY for scenarios that deliberately drive blind off the
   * ribbon - the fixed full-throttle/steer-lock runs whose subject is grass
   * and suspension recovery, and which now end against a wall instead of
   * out in the scenery. Those tests are about the surface under the car once
   * it is off the road, not about the barrier; barrier behaviour is covered
   * by tests/barrierWalls.test.ts.
   */
  walls?: boolean;
  /**
   * Override the spawn pose. Defaults to `track.startPos` at its heading.
   * Only for tests that need to place a car somewhere specific - the barrier
   * collision test drops a car onto the run-off pointing at a wall, which is
   * not a pose any circuit's start line produces. Still a full vehicle sim:
   * same chassis, same raycast suspension, same world.
   */
  spawn?: { x: number; z: number; headingRad: number; speedMs?: number };
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
   * Auto gearbox (plan section 5 depth feature 4) - defaults to true,
   * matching every production caller (Car.tsx, AICar.tsx and this harness).
   * Set false to run the legacy flat-force model (the no-gearbox path of
   * applyCarControls) for A/B comparisons against the geared car.
   */
  autoGear?: boolean;
  /**
   * Per-step off-track distance (meters, 0 = on track), only called when
   * `track` is given. StabilityResult only keeps the single worst value
   * over the whole run - this is for tuning scripts/tests that need the
   * full timeline (e.g. counting how many separate off-track excursions
   * happened, not just how bad the worst one was).
   */
  onStep?: (elapsedSeconds: number, offTrackMeters: number) => void;
  /**
   * Per-step full telemetry dump (position/tilt/speed/inputs plus each
   * wheel's contact flag, suspension force/length, and longitudinal/lateral
   * impulses) - the headless counterpart of plan section 15's in-game
   * telemetry overlay. Fired once per physics step AFTER world.step(), from
   * the live controller/chassis, so it can never influence the simulation -
   * this is what the AI stability diagnostic (tests/aiTelemetry.test.ts, run
   * via `npm run diagnose:ai`) uses to characterize what physically happens
   * during off-track excursions and flips (see
   * [[lift_and_coast_ai_flip_nose_scrape]]: the mechanism turned out to be a
   * chassis-nose rigid-body scrape against the trimesh, not traction loss).
   */
  onTelemetry?: (sample: TelemetrySample) => void;
  /**
   * When true, each telemetry sample includes `chassisContacts` — the list
   * of other colliders the chassis rigid body is touching that step. Used to
   * identify what EXTERNAL object the chassis collides with during a
   * velocity-collapse event (the single-step 50→2 m/s "impact" identified
   * by the per-wheel telemetry diagnostic: wheels all report normal loads
   * and tiny impulses, so it's not a wheel-force event — it must be a
   * rigid-body contact with the trimesh or ground cuboid). Read-only after
   * world.step() via world.contactPairsWith — no simulation impact.
   */
  captureChassisContacts?: boolean;
}

export interface WheelTelemetry {
  isInContact: boolean;
  /** Newtons pushing the chassis up through this suspension, 0 when airborne. */
  suspensionForce: number;
  /** Current compressed suspension length (meters) - 0 = fully topped out. */
  suspensionLength: number;
  /** Longitudinal impulse (N·s) this wheel applied to the chassis this step — the drive/brake traction signal. */
  forwardImpulse: number;
  /** Lateral impulse (N·s) this wheel applied to the chassis this step — the cornering-grip signal. */
  sideImpulse: number;
}

export interface TelemetrySample {
  elapsedSeconds: number;
  position: { x: number; y: number; z: number };
  tiltRad: number;
  /** Signed forward speed (positive = driving forward), see computeSignedForwardSpeed. */
  speedMs: number;
  /** Distance past the track edge in meters (0 = on the ribbon), see checkTrackLimits. */
  offTrackMeters: number;
  throttle: number;
  brake: number;
  steer: number;
  /** Selected gear after this tick's gearbox update (1-based, see gearbox.ts). */
  gear: number;
  /** Engine rpm implied by current speed + gear, see rpmForGear. */
  rpm: number;
  wheels: WheelTelemetry[];
  /**
   * Which other colliders the chassis rigid body is currently touching.
   * Populated via world.contactPairsWith after world.step() — pure read.
   * Values: "ground" (the plane under the track), "track" (the ribbon
   * trimesh). Anything else (only the chassis's own collider) is filtered
   * out. Always present on every sample; empty while the car rides on its
   * wheels normally, populated during a nose scrape (see
   * [[lift_and_coast_ai_flip_nose_scrape]]), and always empty when
   * `captureChassisContacts` is off.
   */
  chassisContacts: string[];
}

export interface StabilityResult {
  maxTiltRad: number;
  /** Signed forward speed at the end of the run (see computeSignedForwardSpeed). */
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
  // Raw collider handles used to label chassisContacts (see
  // captureChassisContacts): ground = the plane under the track, track =
  // the ribbon trimesh. Only populated when captureChassisContacts is set,
  // but assignments are kept unconditional-ish (two branches above) so this
  // stays trivially correct if that option is ever removed.
  let groundHandle = -1;
  let trackHandle = -1;
  let wallHandle = -1;

  if (options.track) {
    // Matches Scene.tsx exactly: the elevation-following grass field under
    // everything plus the track trimesh on top, so a car pushed off the
    // ribbon (e.g. by hard steering) lands on grass like it does in the real
    // game, instead of free-falling through a void and reading as a "flip"
    // that has nothing to do with the vehicle. This used to be a flat cuboid
    // at one altitude, which stopped being the same surface as the game's the
    // moment the track gained elevation. Surface height derived from
    // GRASS_BELOW_TRACK_METERS - see its definition for why that gap.
    // Trackside MASSING (Track.tsx <Structures>) is still visual-only in both
    // worlds: grandstands and buildings stand well beyond the barrier, and a
    // car loose in the scenery should be slowed by the surface, not stopped
    // by a marquee. The BARRIER LINE, though, is physical in the game and
    // must be physical here too - otherwise these gates would be validating
    // a car that drives through walls the player cannot.
    const terrain = buildTerrainGeometry(options.track);
    const groundBody = world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed());
    groundHandle = world
      .createCollider(
        RAPIER_MOD.ColliderDesc.trimesh(terrain.positions, terrain.indices).setFriction(0.6),
        groundBody
      )
      .handle;

    const { positions, indices } = buildRibbonGeometry(options.track);
    const trackBody = world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed());
    trackHandle = world
      .createCollider(RAPIER_MOD.ColliderDesc.trimesh(positions, indices).setFriction(1.3), trackBody)
      .handle;

    // Same mesh the game hangs off <Track>. Restitution 0 on purpose: a wall
    // should absorb the car, not fling it back onto the circuit.
    const walls = options.walls === false ? null : buildBarrierWallMesh(options.track, terrain);
    wallHandle = walls
      ? world
          .createCollider(
            RAPIER_MOD.ColliderDesc.trimesh(walls.positions, walls.indices)
              .setFriction(0.4)
              .setRestitution(0),
            world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed())
          )
          .handle
      : -1;
  } else {
    const groundBody = world.createRigidBody(
      RAPIER_MOD.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0)
    );
    groundHandle = world
      .createCollider(RAPIER_MOD.ColliderDesc.cuboid(1000, 0.5, 1000).setFriction(1.2), groundBody)
      .handle;
  }

  const spawn: { x: number; z: number; headingRad: number; speedMs?: number } =
    options.spawn ?? options.track?.startPos ?? { x: 0, z: 0, headingRad: 0 };
  const chassisDesc = RAPIER_MOD.RigidBodyDesc.dynamic()
    .setTranslation(spawn.x, 1, spawn.z)
    .setRotation(new RAPIER_MOD.Quaternion(0, Math.sin(spawn.headingRad / 2), 0, Math.cos(spawn.headingRad / 2)))
    .setLinearDamping(LINEAR_DAMPING)
    .setAngularDamping(ANGULAR_DAMPING)
    .setCanSleep(false);
  if (spawn.speedMs) {
    // Launch velocity along the spawn heading, so a barrier test can start
    // the car already at racing speed instead of spending its whole run
    // accelerating.
    chassisDesc.setLinvel(
      Math.sin(spawn.headingRad) * spawn.speedMs,
      0,
      Math.cos(spawn.headingRad) * spawn.speedMs
    );
  }
  const chassis = world.createRigidBody(chassisDesc);
  // Matches Car.tsx exactly: mass is set on the one chassis collider via
  // setMass, not setAdditionalMass on the body. They are not equivalent -
  // additional mass stacks on top of the collider's own density-derived
  // mass, so the harness was previously simulating a ~225.76kg car against
  // constants tuned for 220kg.
  const chassisCollider = world.createCollider(
    RAPIER_MOD.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS),
    chassis
  );
  chassisCollider.setMass(CHASSIS_MASS);

  const controller = createCarController(RAPIER_MOD, world, chassis);
  const startPos = chassis.translation();
  const startRotation = chassis.rotation();
  const startYaw = yawFromRotation(startRotation);
  // Auto gearbox for the whole run (plan section 5 depth feature 4): the
  // harness obeys the same gear-modulated physics as the player/AI. Always
  // auto so scripted-input scenarios (which never send shift requests) get
  // the optimal-gear behavior rather than being stuck in 1st.
  const gearbox = createGearboxState(true);

  let maxTilt = 0;
  let maxOffTrackMeters = 0;
  let maxTiltStep = 0;
  let previousTilt: number | null = null;
  let distanceTraveledMeters = 0;
  let previousStepPos = startPos;
  const steps = Math.round(seconds / timestep);
  const defaultAeroMode = options.aeroMode ?? "high-downforce";
  for (let i = 0; i < steps; i++) {
    // Matches Car.tsx: past this distance off-track, snap back to the start
    // line rather than let the car keep going - a long enough straight-line
    // run off-course eventually crosses the finite ground field's edge and
    // crashes the physics engine entirely (found via this harness). Also
    // matches Car.tsx's absolute-distance-from-origin backstop
    // (worldEdgeResetMeters) - see its definition for why the ribbon-
    // distance check alone isn't enough, and why it is track-relative.
    if (options.track) {
      const p = chassis.translation();
      if (
        checkTrackLimits(options.track, p.x, p.z).distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
        Math.hypot(p.x, p.z) > worldEdgeResetMeters(options.track)
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
    const stepAeroMode = stepInput.aeroMode ?? defaultAeroMode;
    applyCarControls(
      controller,
      stepInput,
      options.engineForce,
      stepInput.boostMultiplier ?? options.boostMultiplier ?? 1,
      options.brakeForce,
      controller.currentVehicleSpeed(),
      options.tractionControlEnabled ?? true,
      // gears are on for every caller except explicit legacy A/B runs
      // (options.autoGear === false) - see the option's own comment.
      options.autoGear === false
        ? undefined
        : { state: gearbox, shiftUp: false, shiftDown: false }
    );
    // Surface zones (plan section 4 point 7 / section 5 depth feature 6), the
    // same per-wheel classification the live game runs (Car.tsx/AICar.tsx).
    // Only when driving a real circuit: a flat-plane scenario has no
    // centerline to classify against, and leaving those runs exactly as they
    // were keeps every existing scripted-input stability test measuring the
    // car it was originally tuned on rather than a new one.
    const surfaceSamples = options.track
      ? wheelGroundPositions(chassis).map((wheel) =>
          sampleSurface(options.track as TrackData, wheel.x, wheel.z)
        )
      : null;
    if (surfaceSamples) {
      applyKerbRideHeights(
        controller,
        surfaceSamples.map((sample) => sample.kerbRiseMeters)
      );
      applyLoadSensitiveFriction(
        controller,
        stepAeroMode,
        1,
        wheelSurfaceGrips(surfaceSamples),
        1
      );
    } else {
      applyLoadSensitiveFriction(controller, stepAeroMode);
    }
    controller.updateVehicle(timestep);

    applyVehicleStabilityTorques(chassis, options.stabilizeStrength, timestep);
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), stepAeroMode);
    chassis.applyImpulse({ x: 0, y: -downforceN * timestep, z: 0 }, true);
    applyDragImpulse(chassis, stepAeroMode, timestep);
    applySurfaceDragImpulse(
      chassis,
      surfaceSamples ? meanSurfaceDrag(surfaceSamples) : 0,
      timestep
    );

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
    // Diagnostic-only capture (see onTelemetry's own comment): read-only
    // after world.step(), so this cannot affect the simulation in any way.
    if (options.onTelemetry) {
      const p = chassis.translation();
      const r = chassis.rotation();
      const wheels: WheelTelemetry[] = [];
      for (let w = 0; w < CAR_WHEELS.length; w++) {
        wheels.push({
          isInContact: controller.wheelIsInContact(w),
          suspensionForce: controller.wheelSuspensionForce(w) ?? 0,
          suspensionLength: controller.wheelSuspensionLength(w) ?? 0,
          forwardImpulse: controller.wheelForwardImpulse(w) ?? 0,
          sideImpulse: controller.wheelSideImpulse(w) ?? 0,
        });
      }
      // Who the chassis rigid body is touching THIS step (read-only):
      // distinguishes "ground" (the plane under the track) from "track"
      // (the ribbon trimesh) by raw collider handle. Any other partner is
      // skipped (the only other collider in the world is the chassis's own).
      const chassisContacts: string[] = [];
      if (options.captureChassisContacts) {
        world.contactPairsWith(chassisCollider, (otherCollider) => {
          if (otherCollider.handle === groundHandle) chassisContacts.push("ground");
          else if (otherCollider.handle === trackHandle) chassisContacts.push("track");
          else if (otherCollider.handle === wallHandle) chassisContacts.push("wall");
        });
      }
      options.onTelemetry({
        elapsedSeconds: i * timestep,
        position: { x: p.x, y: p.y, z: p.z },
        tiltRad: tilt,
        speedMs: computeSignedForwardSpeed(chassis.linvel(), yawFromRotation(r)),
        offTrackMeters: options.track
          ? checkTrackLimits(options.track, p.x, p.z).distanceFromEdgeMeters
          : 0,
        throttle: stepInput.throttle,
        brake: stepInput.brake,
        steer: stepInput.steer,
        gear: gearbox.gear,
        rpm: rpmForGear(
          gearboxSpeedMs(gearbox, controller.currentVehicleSpeed()),
          gearbox.gear
        ),
        wheels,
        chassisContacts,
      });
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
    // computeSignedForwardSpeed, not controller.currentVehicleSpeed(): this
    // is a reported result (nothing downstream feeds it back into the
    // simulation), and the raw read can flip sign at high speed, which made
    // any assertion on it - or an A/B comparison between two runs - flaky.
    // See computeSignedForwardSpeed's own comment.
    finalSpeedMs: computeSignedForwardSpeed(chassis.linvel(), endYaw),
    distanceMeters,
    distanceTraveledMeters,
    maxOffTrackMeters,
    netYawChangeRad,
    maxTiltStepRad: maxTiltStep,
  };
}
