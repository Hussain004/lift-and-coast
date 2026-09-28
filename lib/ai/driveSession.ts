/**
 * An interactive drive session: the same physics world and the same control
 * path the headless `simulateDrive` harness builds, but advanced one tick at
 * a time by the caller instead of run to completion in a loop.
 *
 * This exists for the landing-page time attack, where a person drives with
 * their own keyboard rather than an AI controller, so the loop has to be fed
 * by real input arriving between frames. The batch harness cannot do that: it
 * takes a whole input plan up front and returns only aggregates.
 *
 * WHY THIS FILE IS ALMOST ENTIRELY THE HARNESS'S OWN CODE, AND WHY THAT IS THE
 * POINT: a lap-time leaderboard is only meaningful if a lap set on the landing
 * page is timed on the same physics as a lap set in a race. So this calls
 * `applyCarControls` - the exact function Car.tsx and simulateDrive use - with
 * the same arguments in the same order, and then runs the same
 * kerb-ride -> load-sensitive friction -> vehicle update -> stability torque
 * -> downforce -> drag -> surface drag -> world.step sequence. There is no
 * simplified "arcade" drive model here, and there must never be one: an
 * earlier draft hand-rolled thrust/brake/steer as impulses, which would have
 * quietly produced a completely different car and a leaderboard that meant
 * nothing.
 *
 * The one deliberate difference from the batch harness is the per-wheel
 * surface sampling. The harness samples once from the spawn point, because
 * all it needs is grass under a car that has already been thrown off the
 * ribbon. A real lap needs it resampled every tick from the live position, so
 * a wheel that reaches a kerb or a gravel trap mid-corner actually feels it.
 * That is a difference in sampling frequency, not in the physics applied.
 *
 * Fixed 1/60 ticks accumulated against real elapsed time, so a slow browser
 * frame produces a slower lap rather than a physically different one, with a
 * ceiling on catch-up ticks so a backgrounded tab cannot try to simulate
 * thousands of steps in one frame.
 */

import { ensureRapierInit, tiltFromUpright, yawFromRotation } from "./harness";
import {
  applyCarControls,
  applyDragImpulse,
  applyKerbRideHeights,
  applyLoadSensitiveFriction,
  applySurfaceDragImpulse,
  applyVehicleStabilityTorques,
  computeSignedForwardSpeed,
  createCarController,
  wheelGroundPositions,
  ANGULAR_DAMPING,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  LINEAR_DAMPING,
  OFF_TRACK_RESET_METERS,
} from "../physics/vehicle";
import {
  createGearboxState,
  gearboxSpeedMs,
  rpmForGear,
  type GearboxState,
} from "../physics/gearbox";
import { computeDownforceN } from "../physics/aero";
import { buildTerrainGeometry } from "../tracks/terrain";
import { buildRibbonGeometry } from "../tracks/mesh";
import { buildBarrierWallMesh } from "../tracks/structures";
import { checkTrackLimits, worldEdgeResetMeters } from "../tracks/trackLimits";
import { meanSurfaceDrag, sampleSurface } from "../tracks/surfaces";
import type { TrackData } from "../tracks/types";

/** One tick of player input, in the same shape applyCarControls takes. */
export interface SessionInput {
  throttle: number;
  brake: number;
  steer: number;
}

export interface SessionState {
  x: number;
  y: number;
  z: number;
  yawRad: number;
  /** Signed forward speed, m/s (see computeSignedForwardSpeed). */
  speedMs: number;
  gear: number;
  rpm: number;
  /** Metres past the ribbon edge; 0 while on the asphalt. */
  offTrackMeters: number;
  /** Arc-length progress along the lap, wrapping at the start line. */
  progressMeters: number;
  /** Chassis tilt, 0 upright. */
  tiltRad: number;
  /** Simulated seconds since creation or reset. */
  elapsedSeconds: number;
}

export interface DriveSessionOptions {
  track: TrackData;
  /**
   * Tyre grip multiplier - the compound/weather product in the real game. 1
   * is a dry, fresh tyre on dry asphalt, so this defaults to the fastest
   * conditions the game can produce.
   */
  gripMultiplier?: number;
  /** Spawn heading; defaults to the track's own start heading. */
  headingRad?: number;
  aeroMode?: "high-downforce" | "low-drag";
  /** Rolling-start speed, m/s. */
  speedMs?: number;
  /** Traction control, matching the player's default-on assist. */
  tractionControlEnabled?: boolean;
}

export interface DriveSession {
  readonly track: TrackData;
  /**
   * Runs as many fixed 1/60 ticks as fit in `elapsedDelta` real seconds.
   * Returns how many ran, so a caller pacing its own loop can tell that the
   * frame budget was missed.
   */
  advance(elapsedDelta: number, input: SessionInput): number;
  /** State as of the last advance. */
  state(): SessionState;
  /** Back to the grid: position, velocity, gear, clock. */
  reset(): void;
}

const TICK_SECONDS = 1 / 60;
/**
 * Must be at least as large as the elapsed-time clamp below allows (0.5s =
 * 30 ticks), or the cap silently eats ticks from a legitimately chunky frame
 * and the same lap is timed differently depending on the browser's frame
 * pacing. The 0.5s clamp is what protects against a backgrounded tab; this
 * constant only exists so the two agree explicitly.
 */
const MAX_ELAPSED_PER_ADVANCE = 0.5;
const MAX_TICKS_PER_ADVANCE = Math.ceil(MAX_ELAPSED_PER_ADVANCE / TICK_SECONDS);

export async function createDriveSession(options: DriveSessionOptions): Promise<DriveSession> {
  const RAPIER_MOD = await ensureRapierInit();
  const track = options.track;
  const gripMultiplier = options.gripMultiplier ?? 1;
  const aeroMode = options.aeroMode ?? "high-downforce";
  const tractionControl = options.tractionControlEnabled ?? true;

  const world = new RAPIER_MOD.World({ x: 0, y: -9.81, z: 0 });

  // The same world the batch harness builds, so a landing-page lap runs on the
  // real surface: the elevation-following grass field, the ribbon trimesh on
  // top of it, and the physical barrier line. Trackside massing is visual-only
  // in both, exactly as the harness's own comment records.
  const terrain = buildTerrainGeometry(track);
  world.createCollider(
    RAPIER_MOD.ColliderDesc.trimesh(terrain.positions, terrain.indices).setFriction(0.6),
    world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed())
  );
  const ribbon = buildRibbonGeometry(track);
  world.createCollider(
    RAPIER_MOD.ColliderDesc.trimesh(ribbon.positions, ribbon.indices).setFriction(1.3),
    world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed())
  );
  const walls = buildBarrierWallMesh(track, terrain);
  world.createCollider(
    RAPIER_MOD.ColliderDesc.trimesh(walls.positions, walls.indices)
      .setFriction(0.4)
      .setRestitution(0),
    world.createRigidBody(RAPIER_MOD.RigidBodyDesc.fixed())
  );

  // The track's own start position AND heading. Defaulting the heading to 0
  // instead parks the car facing sideways into the pit wall, where it sits
  // unable to move - which is exactly what the first run of this did.
  const headingRad = options.headingRad ?? track.startPos.headingRad;
  const chassisDesc = RAPIER_MOD.RigidBodyDesc.dynamic()
    .setTranslation(track.startPos.x, 1, track.startPos.z)
    .setRotation(
      new RAPIER_MOD.Quaternion(0, Math.sin(headingRad / 2), 0, Math.cos(headingRad / 2))
    )
    .setLinearDamping(LINEAR_DAMPING)
    .setAngularDamping(ANGULAR_DAMPING)
    .setCanSleep(false);
  if (options.speedMs) {
    // Forward is (-sin yaw, -cos yaw) - the same convention as
    // computeSignedForwardSpeed. The obvious (sin, cos) launches the car
    // backwards down the pit lane at the requested speed.
    chassisDesc.setLinvel(
      -Math.sin(headingRad) * options.speedMs,
      0,
      -Math.cos(headingRad) * options.speedMs
    );
  }
  const chassis = world.createRigidBody(chassisDesc);
  // Mass on the one chassis collider via setMass, matching Car.tsx: mass via
  // setAdditionalMass would stack on the collider's density-derived mass.
  world.createCollider(RAPIER_MOD.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis).setMass(
    CHASSIS_MASS
  );

  const controller = createCarController(RAPIER_MOD, world, chassis);
  const gearbox: GearboxState = createGearboxState(true);
  const startPos = chassis.translation();
  const startRotation = chassis.rotation();

  let elapsedSeconds = 0;
  let accumulator = 0;

  /** Reads the chassis into a SessionState. Used for the initial value and
   *  after every tick, so a rolling start reports its speed from frame one
   *  rather than a second later. */
  function readState(): SessionState {
    const rotation = chassis.rotation();
    const position = chassis.translation();
    const yaw = yawFromRotation(rotation);
    const limits = checkTrackLimits(track, position.x, position.z, position.y);
    return {
      x: position.x,
      y: position.y,
      z: position.z,
      yawRad: yaw,
      speedMs: computeSignedForwardSpeed(chassis.linvel(), yaw),
      gear: gearbox.gear,
      rpm: rpmForGear(gearboxSpeedMs(gearbox, controller.currentVehicleSpeed()), gearbox.gear),
      offTrackMeters: limits.distanceFromEdgeMeters,
      progressMeters: limits.progressMeters,
      tiltRad: tiltFromUpright(rotation),
      elapsedSeconds,
    };
  }

  let current: SessionState = readState();

  function tick(input: SessionInput): void {
    const pos = chassis.translation();
    // Same backstop as Car.tsx and simulateDrive: far enough off the ribbon, or
    // too far from the world origin, and the car goes back on the grid rather
    // than running out of the ground field and taking the physics engine with
    // it. A reset is an intentional teleport, not real distance driven.
    if (
      checkTrackLimits(track, pos.x, pos.z).distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > worldEdgeResetMeters(track)
    ) {
      reset();
      return;
    }

    // THE shared control path. Same function, same argument order and the same
    // value for the speed argument (controller.currentVehicleSpeed(), which the
    // harness's own comment explains must stay this rather than the signed
    // forward speed, or every closed-loop gate would change behaviour).
    applyCarControls(
      controller,
      { throttle: input.throttle, brake: input.brake, steer: input.steer },
      DEFAULT_ENGINE_FORCE,
      1,
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed(),
      tractionControl,
      { state: gearbox, shiftUp: false, shiftDown: false }
    );

    // Per-wheel surfaces, resampled from the LIVE position every tick - the one
    // documented difference from the batch harness, so a wheel reaching a kerb
    // or a gravel trap mid-corner feels it.
    const surfaceSamples = wheelGroundPositions(chassis).map((wheel) =>
      sampleSurface(track, wheel.x, wheel.z)
    );
    applyKerbRideHeights(
      controller,
      surfaceSamples.map((sample) => sample.kerbRiseMeters)
    );
    applyLoadSensitiveFriction(
      controller,
      aeroMode,
      gripMultiplier,
      surfaceSamples.map((sample) => sample.gripMultiplier),
      1
    );
    controller.updateVehicle(world.timestep);

    applyVehicleStabilityTorques(chassis, DEFAULT_STABILIZE_STRENGTH, world.timestep);
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), aeroMode);
    chassis.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(chassis, aeroMode, world.timestep);
    applySurfaceDragImpulse(chassis, meanSurfaceDrag(surfaceSamples), world.timestep);

    world.step();

    elapsedSeconds += TICK_SECONDS;
    current = readState();
  }

  function reset(): void {
    chassis.setTranslation(startPos, true);
    chassis.setRotation(startRotation, true);
    chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    elapsedSeconds = 0;
    accumulator = 0;
    gearbox.gear = 1;
    gearbox.speedInitialized = false;
    gearbox.filteredSpeedMs = 0;
    gearbox.shiftCooldownTicks = 0;
    // elapsedSeconds is already 0 here, so readState() reports a clean clock
    // while still telling the truth about position and gear.
    current = readState();
  }

  return {
    track,
    advance(elapsedDelta, input) {
      accumulator += Math.max(0, Math.min(elapsedDelta, MAX_ELAPSED_PER_ADVANCE));
      let ticks = 0;
      while (accumulator >= TICK_SECONDS && ticks < MAX_TICKS_PER_ADVANCE) {
        tick(input);
        accumulator -= TICK_SECONDS;
        ticks++;
      }
      return ticks;
    },
    state: () => current,
    reset,
  };
}
