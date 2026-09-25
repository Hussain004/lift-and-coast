// Headless AI field: N cars on the real track trimesh running the same
// vehicle rig and the same shared racecraft step the live AICar runs (see
// lib/ai/racecraft.ts's stepRacecraft), plus the race metrics the field
// tests gate on - position swaps, lead changes, car-to-car contacts
// (classified side vs nose-to-tail), spins and side-by-side time.
//
// This harness deliberately isolates racecraft/launch stability. Live AICar
// additionally runs strategy, ERS, weather, and overtake state; the
// standing-start benchmark owns the full Pro/Ace pace/line calibration.
import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import {
  ANGULAR_DAMPING,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  LINEAR_DAMPING,
  applyCarControls,
  applyDragImpulse,
  applyKerbRideHeights,
  applyLoadSensitiveFriction,
  applySurfaceDragImpulse,
  computeSignedForwardSpeed,
  computeStabilizingTorque,
  createCarController,
  resolveYawDampingTorque,
  wheelGroundPositions,
  yawFromQuaternion,
} from "../../lib/physics/vehicle";
import { computeDownforceN, towDragScale, type AeroMode } from "../../lib/physics/aero";
import { createGearboxState } from "../../lib/physics/gearbox";
import { buildRibbonGeometry } from "../../lib/tracks/mesh";
import { buildTerrainGeometry } from "../../lib/tracks/terrain";
import { checkTrackLimits } from "../../lib/tracks/trackLimits";
import { meanSurfaceDrag, sampleSurface, wheelSurfaceGrips } from "../../lib/tracks/surfaces";
import { getLineRoom, getRacingLine } from "../../lib/tracks/racingLineCache";
import { createEnergySystem } from "../../lib/physics/energy";
import { computeAIControls, nearestLineIndex } from "../../lib/ai/pathFollower";
import {
  difficultyAggressionShift,
  difficultyEngineForceScale,
  difficultyPaceScale,
  tireCurveMultiplier,
  traitsForDriver,
  type AIDifficulty,
} from "../../lib/ai/personalities";
import {
  AI_LAUNCH_LATERAL_RATE_NARROW_MS,
  AI_LAUNCH_LATERAL_RATE_SPA_MS,
  applyLaunchControl,
  createRacecraftState,
  lateralAtLineIndex,
  lineContextAt,
  lineDirectionAt,
  refineGap,
  lineIndexAtProgress,
  resetRacecraftState,
  stepRacecraft,
  unwrapGap,
  type FieldCarView,
  type RacecraftState,
} from "../../lib/ai/racecraft";
import {
  createRecoveryState,
  findRecoveryIndex,
  recoveryPose,
  updateRecovery,
  type RecoveryState,
} from "../../lib/ai/recovery";
import { createLapTimer, standingsLapCount } from "../../lib/race/lapTimer";
import { gridSlot } from "../../lib/race/grid";
import silverstone from "../../data/tracks/silverstone.json";
import type { TrackData } from "../../lib/tracks/types";

const UP = new Vector3(0, 1, 0);

interface SimCar {
  code: string;
  chassis: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.DynamicRayCastVehicleController;
  gearbox: ReturnType<typeof createGearboxState>;
  aeroMode: AeroMode;
  lapTimer: ReturnType<typeof createLapTimer>;
  lapCount: number;
  progressMeters: number;
  speedMs: number;
  racecraft: RacecraftState;
  attemptTicks: number;
  maxOffset: number;
  zone: "throttle" | "lift" | "brake-medium" | "brake-hard";
  energy: ReturnType<typeof createEnergySystem>;
  battery: number;
  boostEligible: boolean;
  maxTilt: number;
  maxOffTrack: number;
  traveled: number;
  prevX: number;
  prevZ: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
  spawnYaw: number;
  sliding: boolean;
  spins: number;
  anchor: number;
  lateral: number;
  recovery: RecoveryState;
  recoveries: number;
}

export interface CarResult {
  code: string;
  maxTilt: number;
  maxOffTrack: number;
  traveled: number;
  attemptTicks: number;
  maxOffset: number;
  finalBattery: number;
  spins: number;
  recoveries: number;
}

export interface FieldMetrics {
  leadChanges: number;
  /** Completed overtakes: a pair's order flips and stays flipped for 3s. */
  passes: number;
  firewallResets: number;
  /** Rising-edge car-to-car contact events. */
  contacts: number;
  /** Contacts with the other car beside (bodies overlapping lengthwise). */
  sideContacts: number;
  /** Contacts with more than 4 m/s relative speed. */
  hardContacts: number;
  /** Contacts involving a parked car. */
  parkedContacts: number;
  /** Summed seconds any pair spent genuinely side by side. */
  sideBySideSeconds: number;
  spins: number;
  recoveries: number;
}

export interface FieldResult {
  cars: CarResult[];
  field: FieldMetrics;
}

export interface FieldSimOptions {
  seconds: number;
  track?: TrackData;
  /** Everyone sits on the brakes this long before launching. */
  holdSeconds?: number;
  /** Grid slot multiplier: 3 spreads the field (no concertina). */
  slotScale?: number;
  /** Driver codes that never drive (parked obstacles). */
  parked?: readonly string[];
  difficulty?: AIDifficulty;
  /** Race length for the tire curve's clock. */
  raceLaps?: number;
  trace?: boolean;
}

export async function simulateField(order: string[], options: FieldSimOptions): Promise<FieldResult> {
  await RAPIER.init();
  const {
    seconds,
    holdSeconds = 0,
    slotScale = 1,
    parked = [],
    difficulty = "pro",
    raceLaps = 3,
    trace = false,
  } = options;
  const track = (options.track ?? silverstone) as TrackData;
  const lineProfile =
    difficulty === "ace" ? "ace" : difficulty === "pro" ? "pro" : "default";
  const racingLine = getRacingLine(track, lineProfile);
  const room = getLineRoom(track, lineProfile);
  const timestep = 1 / 60;
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

  const terrain = buildTerrainGeometry(track);
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.trimesh(terrain.positions, terrain.indices).setFriction(0.6),
    groundBody
  );
  const { positions, indices } = buildRibbonGeometry(track);
  const trackBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(1.3), trackBody);

  const cars: SimCar[] = order.map((code, slot) => {
    const grid = gridSlot(track, slot * slotScale);
    const chassis = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(grid.x, grid.y, grid.z)
        .setRotation(
          new RAPIER.Quaternion(
            0,
            Math.sin(grid.headingRad / 2),
            0,
            Math.cos(grid.headingRad / 2)
          )
        )
        .setLinearDamping(LINEAR_DAMPING)
        .setAngularDamping(ANGULAR_DAMPING)
        .setCanSleep(false)
    );
    const collider = world.createCollider(RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS), chassis);
    collider.setMass(CHASSIS_MASS);
    return {
      code,
      chassis,
      collider,
      spawnX: grid.x,
      spawnY: grid.y,
      spawnZ: grid.z,
      spawnYaw: grid.headingRad,
      controller: createCarController(RAPIER, world, chassis),
      gearbox: createGearboxState(true),
      aeroMode: "high-downforce" as AeroMode,
      lapTimer: createLapTimer({
        startPos: track.startPos,
        lineHalfWidth: 6,
        startsBehindLine: grid.startsBehindLine,
      }),
      lapCount: 0,
      progressMeters: 0,
      speedMs: 0,
      racecraft: createRacecraftState(),
      attemptTicks: 0,
      maxOffset: 0,
      zone: "throttle" as const,
      energy: createEnergySystem(),
      battery: 1,
      boostEligible: false,
      maxTilt: 0,
      maxOffTrack: 0,
      traveled: 0,
      prevX: grid.x,
      prevZ: grid.z,
      sliding: false,
      spins: 0,
      anchor: nearestLineIndex(racingLine, grid.x, grid.z),
      lateral: 0,
      recovery: createRecoveryState(),
      recoveries: 0,
    };
  });

  const totalOf = (car: SimCar): number => car.lapCount * track.lengthMeters + car.progressMeters;
  const field: FieldMetrics = {
    leadChanges: 0,
    passes: 0,
    firewallResets: 0,
    contacts: 0,
    sideContacts: 0,
    hardContacts: 0,
    parkedContacts: 0,
    sideBySideSeconds: 0,
    spins: 0,
    recoveries: 0,
  };
  let lastLeader = 0;
  const pairOrder = new Map<number, { sign: number; pending: number; held: number }>();
  // Last tick each pair was touching: one grinding contact flickers in and
  // out of the narrow phase, so a new event needs half a second apart.
  const lastTouch = new Map<string, number>();

  const steps = Math.round(seconds / timestep);
  for (let i = 0; i < steps; i++) {
    // NaN firewall (mirrors the game backstop in AICar.tsx).
    for (const car of cars) {
      const fp = car.chassis.translation();
      const fl = car.chassis.linvel();
      const fr = car.chassis.rotation();
      if (![fp.x, fp.y, fp.z, fl.x, fl.y, fl.z, fr.x, fr.y, fr.z, fr.w].every(Number.isFinite)) {
        field.firewallResets++;
        car.chassis.setTranslation({ x: car.spawnX, y: car.spawnY, z: car.spawnZ }, true);
        car.chassis.setRotation(
          new RAPIER.Quaternion(0, Math.sin(car.spawnYaw / 2), 0, Math.cos(car.spawnYaw / 2)),
          true
        );
        car.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
        car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }
    }
    // Lap/progress bookkeeping for every car first (mirrors AICar: the lap
    // section runs before the controls in the same tick).
    for (const car of cars) {
      const p = car.chassis.translation();
      const status = checkTrackLimits(track, p.x, p.z, p.y);
      car.maxOffTrack = Math.max(car.maxOffTrack, status.distanceFromEdgeMeters);
      const lap = car.lapTimer.update({ x: p.x, z: p.z }, timestep);
      // Same standings rule the game feeds racecraft (see standingsLapCount).
      car.lapCount = standingsLapCount(lap, status.progressMeters, track.lengthMeters);
      car.progressMeters = status.progressMeters;
      const rot = car.chassis.rotation();
      const yaw = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
      car.speedMs = computeSignedForwardSpeed(car.chassis.linvel(), yaw);
      car.anchor = nearestLineIndex(racingLine, p.x, p.z, car.anchor);
      car.lateral = lateralAtLineIndex(
        racingLine,
        lineIndexAtProgress(car.progressMeters, track.lengthMeters, racingLine.length),
        p.x,
        p.z
      );
    }
    if (i % 60 === 0) {
      const ranked = [...cars].sort((a, b) => totalOf(b) - totalOf(a));
      const leader = cars.indexOf(ranked[0]);
      if (i > 0 && leader !== lastLeader) field.leadChanges++;
      lastLeader = leader;
      // Pass events: per pair, the sign of who is ahead; a flip only counts
      // once it has held for three consecutive one-second samples.
      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          const key = a * cars.length + b;
          const sign = totalOf(cars[a]) >= totalOf(cars[b]) ? 1 : -1;
          const state = pairOrder.get(key);
          if (!state) {
            pairOrder.set(key, { sign, pending: sign, held: 0 });
          } else if (sign === state.sign) {
            state.pending = sign;
            state.held = 0;
          } else {
            state.held = state.pending === sign ? state.held + 1 : 1;
            state.pending = sign;
            if (state.held >= 3) {
              state.sign = sign;
              state.held = 0;
              field.passes++;
            }
          }
        }
      }
    }
    const held = i * timestep < holdSeconds;
    for (const car of cars) {
      const traits = traitsForDriver(car.code);
      const raceProgress = Math.min(1, Math.max(0, car.lapCount / Math.max(1, raceLaps)));
      const basePace =
        traits.pace * difficultyPaceScale(difficulty, track.id) * tireCurveMultiplier(traits.latePace, raceProgress);
      const aggression = Math.min(1, Math.max(0, traits.aggression + difficultyAggressionShift(difficulty)));
      const p = car.chassis.translation();
      const rot = car.chassis.rotation();
      const yaw = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
      const others: FieldCarView[] = [];
      const dir = lineDirectionAt(racingLine, car.anchor);
      for (const other of cars) {
        if (other === car) continue;
        const op = other.chassis.translation();
        others.push({
          key: other.code,
          gapMeters: refineGap(
            unwrapGap(car.lapCount, car.progressMeters, other.lapCount, other.progressMeters, track.lengthMeters),
            p.x,
            p.z,
            op.x,
            op.z,
            dir.x,
            dir.z
          ),
          rawGapMeters: totalOf(other) - totalOf(car),
          speedMs: other.speedMs,
          lateralMeters: other.lateral,
        });
      }
      const parkedCar = parked.includes(car.code);
      if (!held && !parkedCar) car.racecraft.raceSeconds += timestep;
      const step = stepRacecraft(car.racecraft, {
        ownSpeedMs: car.speedMs,
        ownLateralMeters: car.lateral,
        basePace,
        cars: others,
        line: lineContextAt(racingLine, room, car.anchor, Math.abs(car.speedMs), basePace, car.zone),
        aggression,
        risk: traits.risk,
        overtakeSide: traits.overtakeSide,
        dt: timestep,
        trackLengthMeters: track.lengthMeters,
        boostEligible: car.boostEligible,
        batteryFraction: car.battery,
        mistakeActive: false,
        aeroMode: car.aeroMode,
        launchLateralRateMs:
          track.id === "monaco"
            ? AI_LAUNCH_LATERAL_RATE_NARROW_MS
            : track.id === "spa"
              ? AI_LAUNCH_LATERAL_RATE_SPA_MS
              : undefined,
      });
      car.aeroMode = step.aeroMode;
      if (step.attempting) car.attemptTicks++;
      const upY = 1 - 2 * (rot.x * rot.x + rot.z * rot.z);
      const recoverAt =
        !parkedCar &&
        updateRecovery(car.recovery, {
          racing: !held,
          speedMs: car.speedMs,
          upY,
          blocked: step.blocked,
          dt: timestep,
        })
          ? findRecoveryIndex(racingLine, car.anchor, others.map((other) => other.gapMeters))
          : null;
      if (recoverAt !== null) {
        const pose = recoveryPose(racingLine, recoverAt);
        car.chassis.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, true);
        car.chassis.setRotation(new RAPIER.Quaternion(0, Math.sin(pose.yaw / 2), 0, Math.cos(pose.yaw / 2)), true);
        car.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
        car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        car.recovery = createRecoveryState();
        resetRacecraftState(car.racecraft);
        car.recoveries++;
        field.recoveries++;
        car.prevX = pose.x;
        car.prevZ = pose.z;
        if (trace) console.log(`RECOVER t=${(i * timestep).toFixed(1)} ${car.code}`);
      }
      car.maxOffset = Math.max(car.maxOffset, Math.abs(car.racecraft.offset));
      const deploying = !parkedCar && !held && step.deploy;
      const baseControls = parkedCar
        ? { throttle: 0, brake: 1, steer: 0, zone: car.zone, boostEligible: false }
        : held
        ? { throttle: 0, brake: 1, steer: 0, zone: car.zone, boostEligible: false }
        : computeAIControls(
            racingLine,
            p.x,
            p.z,
            yaw,
            car.speedMs,
            deploying,
            step.paceMult,
            step.steerOffsetMeters,
            car.anchor
          );
      const controls = applyLaunchControl(
        baseControls,
        step.launchThrottleFloor,
        !held && !parkedCar
      );
      const launchTractionControlDisabled =
        !held && !parkedCar && step.launchThrottleFloor > 0 && controls.brake < 1;
      car.zone = controls.zone;
      car.boostEligible = controls.boostEligible;
      let boostMultiplier = 1;
      if (!parkedCar && !held) {
        const energyStatus = car.energy.update(
          { brakeAmount: controls.brake, deployRequested: deploying, overrideActive: step.override },
          timestep
        );
        car.battery = energyStatus.batteryFraction;
        boostMultiplier = energyStatus.engineForceMultiplier;
      }
      applyCarControls(
        car.controller,
        controls,
        DEFAULT_ENGINE_FORCE * difficultyEngineForceScale(difficulty, track.id),
        boostMultiplier,
        DEFAULT_BRAKE_FORCE,
        car.speedMs,
        !launchTractionControlDisabled,
        { state: car.gearbox, shiftUp: false, shiftDown: false }
      );
    }
    if (trace && i % 120 === 0) {
      console.log(
        `t=${(i * timestep).toFixed(2)} ` +
          cars
            .map(
              (c) =>
                `${c.code}@${totalOf(c).toFixed(1)} v=${c.speedMs.toFixed(1)} off=${c.racecraft.offset.toFixed(1)} att=${c.racecraft.attemptKey ?? "-"}`
            )
            .join(" | ")
      );
    }
    try {
      world.step();
    } catch (err) {
      const dump = cars.map((car) => {
        const p = car.chassis.translation();
        return `${car.code}@${[p.x, p.y, p.z].map((v) => v.toFixed(1)).join(",")}`;
      });
      console.log(`PANIC at tick ${i}: ${dump.join(" ")}`);
      throw err;
    }
    // Car-to-car contacts, classified from the first car's frame.
    for (let a = 0; a < cars.length; a++) {
      for (let b = a + 1; b < cars.length; b++) {
        const ca = cars[a];
        const cb = cars[b];
        let inContact = false;
        world.contactPair(ca.collider, cb.collider, (manifold) => {
          if (manifold.numContacts() > 0) inContact = true;
        });
        const key = `${a}:${b}`;
        const last = lastTouch.get(key);
        if (inContact && (last === undefined || i - last > 30)) {
          field.contacts++;
          const pa = ca.chassis.translation();
          const pb = cb.chassis.translation();
          const ra = ca.chassis.rotation();
          const yawA = yawFromQuaternion(ra.x, ra.y, ra.z, ra.w);
          const dx = pb.x - pa.x;
          const dz = pb.z - pa.z;
          const lon = dx * -Math.sin(yawA) + dz * -Math.cos(yawA);
          const lat = dx * Math.cos(yawA) + dz * -Math.sin(yawA);
          if (Math.abs(lon) < 3.2 && Math.abs(lat) > 1.0) field.sideContacts++;
          const va = ca.chassis.linvel();
          const vb = cb.chassis.linvel();
          if (Math.hypot(vb.x - va.x, vb.z - va.z) > 4) field.hardContacts++;
          if (parked.includes(ca.code) || parked.includes(cb.code)) field.parkedContacts++;
          if (trace) {
            console.log(
              `CONTACT t=${(i * timestep).toFixed(1)} ${ca.code}/${cb.code} lon=${lon.toFixed(1)} lat=${lat.toFixed(1)} dv=${Math.hypot(vb.x - va.x, vb.z - va.z).toFixed(1)} offA=${ca.racecraft.offset.toFixed(1)} offB=${cb.racecraft.offset.toFixed(1)} attA=${ca.racecraft.attemptKey ?? "-"} attB=${cb.racecraft.attemptKey ?? "-"} vA=${ca.speedMs.toFixed(0)}`
            );
          }
        }
        if (inContact) lastTouch.set(key, i);
        const gap = Math.abs(totalOf(cb) - totalOf(ca));
        if (gap < 5) {
          const pa = ca.chassis.translation();
          const pb = cb.chassis.translation();
          const ra = ca.chassis.rotation();
          const yawA = yawFromQuaternion(ra.x, ra.y, ra.z, ra.w);
          const lat = (pb.x - pa.x) * Math.cos(yawA) + (pb.z - pa.z) * -Math.sin(yawA);
          if (Math.abs(lat) > 1.6 && Math.abs(lat) < 6) field.sideBySideSeconds += timestep;
        }
      }
    }
    for (const car of cars) {
      const samples = wheelGroundPositions(car.chassis).map((wheel) => sampleSurface(track, wheel.x, wheel.z));
      applyKerbRideHeights(
        car.controller,
        samples.map((sample) => sample.kerbRiseMeters)
      );
      applyLoadSensitiveFriction(car.controller, car.aeroMode, 1, wheelSurfaceGrips(samples), 1);
      car.controller.updateVehicle(timestep);
      const rot = car.chassis.rotation();
      const torque = computeStabilizingTorque(rot, DEFAULT_STABILIZE_STRENGTH);
      if (torque[0] || torque[1] || torque[2]) {
        car.chassis.applyTorqueImpulse(
          { x: torque[0] * timestep, y: torque[1] * timestep, z: torque[2] * timestep },
          true
        );
      }
      const yawDamping = resolveYawDampingTorque(car.chassis.angvel().y);
      if (yawDamping !== 0) {
        car.chassis.applyTorqueImpulse({ x: 0, y: yawDamping * timestep, z: 0 }, true);
      }
      car.chassis.applyImpulse(
        {
          x: 0,
          y: -computeDownforceN(car.controller.currentVehicleSpeed(), car.aeroMode) * timestep,
          z: 0,
        },
        true
      );
      const cp = car.chassis.translation();
      const cv = car.chassis.linvel();
      const towDrag = towDragScale(
        { x: cp.x, z: cp.z, yawRad: yawFromQuaternion(rot.x, rot.y, rot.z, rot.w), speedMs: Math.hypot(cv.x, cv.z) },
        cars.filter((other) => other !== car).map((other) => other.chassis.translation())
      );
      applyDragImpulse(car.chassis, car.aeroMode, timestep, towDrag);
      applySurfaceDragImpulse(car.chassis, meanSurfaceDrag(samples), timestep);
      const bodyUp = new Vector3(0, 1, 0).applyQuaternion(new Quaternion(rot.x, rot.y, rot.z, rot.w));
      car.maxTilt = Math.max(car.maxTilt, bodyUp.angleTo(UP));
      const q = car.chassis.translation();
      car.traveled += Math.hypot(q.x - car.prevX, q.z - car.prevZ);
      car.prevX = q.x;
      car.prevZ = q.z;
      // Spin: velocity more than ~30 degrees off the heading at speed.
      const v = car.chassis.linvel();
      const speed = Math.hypot(v.x, v.z);
      const yaw = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
      const cosSlip = speed > 12 ? (v.x * -Math.sin(yaw) + v.z * -Math.cos(yaw)) / speed : 1;
      const sliding = cosSlip < Math.cos(0.5);
      if (sliding && !car.sliding) {
        car.spins++;
        field.spins++;
        if (trace) console.log(`SPIN t=${(i * timestep).toFixed(1)} ${car.code} v=${speed.toFixed(0)}`);
      }
      car.sliding = sliding;
    }
  }

  return {
    cars: cars.map((car) => ({
      code: car.code,
      maxTilt: car.maxTilt,
      maxOffTrack: car.maxOffTrack,
      traveled: car.traveled,
      attemptTicks: car.attemptTicks,
      maxOffset: car.maxOffset,
      finalBattery: car.battery,
      spins: car.spins,
      recoveries: car.recoveries,
    })),
    field,
  };
}
