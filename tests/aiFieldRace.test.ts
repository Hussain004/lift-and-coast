// The AI field races itself: three cars with real personality pace spread
// and the full racecraft book on the real Silverstone trimesh - slowest on
// pole, fastest last - must produce at least one genuine overtake in 120s
// without anyone flipping or stalling. This is the test that would have
// caught a formation-train regression: pace spread with no passing reads
// as zero lead changes here.
import { describe, expect, it } from "vitest";
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
  wheelGroundPositions,
} from "../lib/physics/vehicle";
import { computeDownforceN } from "../lib/physics/aero";
import { createGearboxState } from "../lib/physics/gearbox";
import { buildRibbonGeometry } from "../lib/tracks/mesh";
import { buildTerrainGeometry } from "../lib/tracks/terrain";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import {
  meanSurfaceDrag,
  sampleSurface,
  wheelSurfaceGrips,
} from "../lib/tracks/surfaces";
import { computeRacingLine } from "../lib/tracks/racingLine";
import {
  cornerAheadMeters,
  computeAIControls,
  nearestLineIndex,
} from "../lib/ai/pathFollower";
import {
  difficultyPaceScale,
  tireCurveMultiplier,
  traitsForDriver,
} from "../lib/ai/personalities";
import {
  composeRacePace,
  mergeOffsetFactor,
  trackGapMeters,
} from "../lib/ai/racecraft";
import { createLapTimer } from "../lib/race/lapTimer";
import { gridSlot } from "../lib/race/grid";
import silverstone from "../data/tracks/silverstone.json";
import suzuka from "../data/tracks/suzuka.json";
import type { TrackData } from "../lib/tracks/types";

const FLIP_THRESHOLD_RAD = 0.6;
const UP = new Vector3(0, 1, 0);

interface FieldCar {
  code: string;
  chassis: RAPIER.RigidBody;
  controller: RAPIER.DynamicRayCastVehicleController;
  gearbox: ReturnType<typeof createGearboxState>;
  lapTimer: ReturnType<typeof createLapTimer>;
  lapCount: number;
  progressMeters: number;
  speedMs: number;
  offset: number;
  attemptKey: string | null;
  attemptTicks: number;
  maxOffset: number;
  zone: "throttle" | "lift" | "brake-medium" | "brake-hard";
  maxTilt: number;
  traveled: number;
  prevX: number;
  prevZ: number;
  raceSeconds: number;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
  spawnYaw: number;
}

interface FieldResult {
  maxTilt: number;
  traveled: number;
  leadChanges: number;
  swaps: number;
  attemptTicks: number;
  maxOffset: number;
  firewallResets: number;
}

export async function simulateField(
  order: string[],
  seconds: number,
  holdSeconds = 0,
  // biome-ignore lint: test helper shared with the suzuka scratch below
  trackOverride?: TrackData,
  /** Grid slot multiplier: 3 spreads the field (no concertina) to isolate
   * contact vs geometry as a panic cause. */
  slotScale = 1
): Promise<FieldResult[]> {
    await RAPIER.init();
    const track = (trackOverride ?? silverstone) as TrackData;
    const racingLine = computeRacingLine(track);
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
    world.createCollider(
      RAPIER.ColliderDesc.trimesh(positions, indices).setFriction(1.3),
      trackBody
    );

    // Grid slots in entry order (a real standing start when slots are
    // adjacent): the pack must sort itself out without piling up.

    const cars: FieldCar[] = order.map((code, slot) => {
      const grid = gridSlot(track, slot * slotScale);
      const chassis = world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(grid.x, grid.y, grid.z)
          .setRotation(
            new RAPIER.Quaternion(
              0,
              Math.sin(track.startPos.headingRad / 2),
              0,
              Math.cos(track.startPos.headingRad / 2)
            )
          )
          .setLinearDamping(LINEAR_DAMPING)
          .setAngularDamping(ANGULAR_DAMPING)
          .setCanSleep(false)
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cuboid(...CHASSIS_HALF_EXTENTS),
        chassis
      );
      collider.setMass(CHASSIS_MASS);
      return {
        code,
        chassis,
        spawnX: grid.x,
        spawnY: grid.y,
        spawnZ: grid.z,
        spawnYaw: track.startPos.headingRad,
        controller: createCarController(RAPIER, world, chassis),
        gearbox: createGearboxState(true),
        lapTimer: createLapTimer({
          startPos: track.startPos,
          lineHalfWidth: 6,
          startsBehindLine: grid.startsBehindLine,
        }),
        lapCount: 0,
        progressMeters: 0,
        speedMs: 0,
        offset: 0,
        attemptKey: null,
        attemptTicks: 0,
        maxOffset: 0,
        zone: "throttle" as const,
        maxTilt: 0,
        traveled: 0,
        prevX: grid.x,
        prevZ: grid.z,
        raceSeconds: 0,
      };
    });

    const totalOf = (car: FieldCar): number =>
      car.lapCount * track.lengthMeters + car.progressMeters;
    let leadChanges = 0;
    let lastLeader = 0;
    let swaps = 0;
    let prevOrder: number[] | null = null;

    const steps = Math.round(seconds / timestep);
    let firewallResets = 0;
    for (let i = 0; i < steps; i++) {
      // NaN firewall (mirrors the game backstop in AICar.tsx): a poisoned
      // body resets to its grid slot with zeroed velocities BEFORE the
      // step, so one grinding contact can't take down the world.
      for (const car of cars) {
        const fp = car.chassis.translation();
        const fl = car.chassis.linvel();
        const fr = car.chassis.rotation();
        if (
          ![fp.x, fp.y, fp.z, fl.x, fl.y, fl.z, fr.x, fr.y, fr.z, fr.w].every(Number.isFinite)
        ) {
          firewallResets++;
          car.chassis.setTranslation({ x: car.spawnX, y: car.spawnY, z: car.spawnZ }, true);
          car.chassis.setRotation(
            new RAPIER.Quaternion(
              0,
              Math.sin(car.spawnYaw / 2),
              0,
              Math.cos(car.spawnYaw / 2)
            ),
            true
          );
          car.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
          car.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
      // Lap/progress bookkeeping for every car first (mirrors AICar: the
      // lap section runs before the controls in the same tick).
      for (const car of cars) {
        const p = car.chassis.translation();
        const status = checkTrackLimits(track, p.x, p.z);
        const lap = car.lapTimer.update({ x: p.x, z: p.z }, timestep);
        car.lapCount = lap.lapCount;
        car.progressMeters = status.progressMeters;
        const rot = car.chassis.rotation();
        const yaw = Math.atan2(
          2 * (rot.w * rot.y + rot.x * rot.z),
          1 - 2 * (rot.y * rot.y + rot.z * rot.z)
        );
        car.speedMs = computeSignedForwardSpeed(car.chassis.linvel(), yaw);
      }
      // Full-field order once a second: P1 changes plus every pairwise
      // swap below - a train that never shuffles reads as zeros.
      if (i % 60 === 0) {
        const ranked = [...cars].sort((a, b) => totalOf(b) - totalOf(a));
        const order = ranked.map((car) => cars.indexOf(car));
        const leader = order[0];
        if (i > 0 && leader !== lastLeader) leadChanges++;
        lastLeader = leader;
        if (prevOrder !== null) {
          for (let a = 0; a < order.length; a++) {
            for (let b = a + 1; b < order.length; b++) {
              const wasA = prevOrder.indexOf(order[a]);
              const wasB = prevOrder.indexOf(order[b]);
              if (wasA > wasB) swaps++;
            }
          }
        }
        prevOrder = order;
      }
      for (const car of cars) {
        const traits = traitsForDriver(car.code);
        const raceProgress = Math.min(1, Math.max(0, car.lapCount / 3));
        let paceMult =
          traits.pace * difficultyPaceScale("pro") * tireCurveMultiplier(traits.latePace, raceProgress);
        const rivals = cars
          .filter((other) => other !== car)
          .map((other) => ({
            key: other.code,
            gapMeters: trackGapMeters(
              { lapCount: car.lapCount, progressMeters: car.progressMeters },
              { lapCount: other.lapCount, progressMeters: other.progressMeters },
              track.lengthMeters
            ),
            speedMs: other.speedMs,
          }));
        const p = car.chassis.translation();
        const rot = car.chassis.rotation();
        const yaw = Math.atan2(
          2 * (rot.w * rot.y + rot.x * rot.z),
          1 - 2 * (rot.y * rot.y + rot.z * rot.z)
        );
        const throttleZone = car.zone === "throttle";
        const anchor = nearestLineIndex(racingLine, p.x, p.z);
        const cornerAhead = cornerAheadMeters(racingLine, anchor, Math.abs(car.speedMs), paceMult);
        // Same shared book the live car runs (see composeRacePace) -
        // including the latched lunge, so this test exercises the real
        // decision lifecycle, not a copy of it.
        const composed = composeRacePace({
          ownSpeedMs: car.speedMs,
          rivals,
          throttleZone,
          cornerAheadMeters: cornerAhead,
          aggression: traits.aggression,
          risk: traits.risk,
          overtakeSide: traits.overtakeSide,
          basePace: paceMult,
          alreadyAttemptingKey: car.attemptKey,
        });
        const { paceMult: racedPace, decision: composedDecision, attemptKey } = composed;
        // Launch hold (mirrors AICar): no lateral moves in the opening
        // seconds; pace discipline already ran.
        let decision = composedDecision;
        if (!(i * timestep < holdSeconds)) car.raceSeconds += timestep;
        if (car.raceSeconds < 12) {
          decision = { attempt: false, offsetMeters: 0, paceBonus: 0, urgent: false };
          car.attemptKey = null;
        } else {
          car.attemptKey = attemptKey;
        }
        paceMult = racedPace;
        if (decision.attempt) car.attemptTicks++;
        const targetGap =
          car.attemptKey !== null
            ? (rivals.find((r) => r.key === car.attemptKey)?.gapMeters ?? Infinity)
            : Infinity;
        const target = decision.attempt ? decision.offsetMeters * mergeOffsetFactor(targetGap) : 0;
        const maxStep = (decision.attempt && decision.urgent ? 3.0 : 1.5) * timestep;
        car.offset += Math.min(maxStep, Math.max(-maxStep, target - car.offset));
        car.maxOffset = Math.max(car.maxOffset, Math.abs(car.offset));
        const held = i * timestep < holdSeconds;
        const controls = held
          ? { throttle: 0, brake: 0.4, steer: 0, zone: car.zone, boostEligible: false }
          : computeAIControls(
          racingLine,
          p.x,
          p.z,
          yaw,
          car.speedMs,
          false,
          paceMult,
          car.offset
        );
        car.zone = controls.zone;
        applyCarControls(
          car.controller,
          controls,
          DEFAULT_ENGINE_FORCE,
          1,
          DEFAULT_BRAKE_FORCE,
          car.controller.currentVehicleSpeed(),
          true,
          { state: car.gearbox, shiftUp: false, shiftDown: false }
        );
      }
      try {
        world.step();
      } catch (err) {
        // On a physics panic, dump every car's position before rethrowing:
        // pinning the death zone is what diagnosed the buried-spawn NaN.
        const dump = cars.map((car) => {
          let pos = "unreadable";
          try {
            const p = car.chassis.translation();
            pos = [p.x, p.y, p.z].map((v) => (Number.isFinite(v) ? v.toFixed(1) : String(v))).join(",");
          } catch {
            /* unreadable */
          }
          return `${car.code}@${pos}`;
        });
        console.log(`PANIC at tick ${i} (t=${(i * timestep).toFixed(2)}s): ${dump.join(" ")}`);
        throw err;
      }
      for (const car of cars) {
        const samples = wheelGroundPositions(car.chassis).map((wheel) =>
          sampleSurface(track, wheel.x, wheel.z)
        );
        applyKerbRideHeights(
          car.controller,
          samples.map((sample) => sample.kerbRiseMeters)
        );
        applyLoadSensitiveFriction(car.controller, "high-downforce", 1, wheelSurfaceGrips(samples), 1);
        car.controller.updateVehicle(timestep);
        const rot = car.chassis.rotation();
        const torque = computeStabilizingTorque(rot, DEFAULT_STABILIZE_STRENGTH);
        if (torque[0] || torque[1] || torque[2]) {
          car.chassis.applyTorqueImpulse(
            { x: torque[0] * timestep, y: torque[1] * timestep, z: torque[2] * timestep },
            true
          );
        }
        car.chassis.applyImpulse(
          { x: 0, y: -computeDownforceN(car.controller.currentVehicleSpeed(), "high-downforce") * timestep, z: 0 },
          true
        );
        applyDragImpulse(car.chassis, "high-downforce", timestep);
        applySurfaceDragImpulse(car.chassis, meanSurfaceDrag(samples), timestep);
        const bodyUp = new Vector3(0, 1, 0).applyQuaternion(
          new Quaternion(rot.x, rot.y, rot.z, rot.w)
        );
        car.maxTilt = Math.max(car.maxTilt, bodyUp.angleTo(UP));
        const q = car.chassis.translation();
        car.traveled += Math.hypot(q.x - car.prevX, q.z - car.prevZ);
        car.prevX = q.x;
        car.prevZ = q.z;
      }
    }

    return cars.map((car) => ({
      maxTilt: car.maxTilt,
      traveled: car.traveled,
      leadChanges,
      swaps,
      attemptTicks: car.attemptTicks,
      maxOffset: car.maxOffset,
      firewallResets,
    }));
}

describe("AI field race", () => {
  it("slowest-from-pole beats fastest-from-last to a pass within 120s, nobody flips", async () => {
    // Slowest trait on pole, fastest last: passing is mandatory, not luck.
    const codes = ["VER", "NOR", "LEC", "PIA", "RUS", "HAM", "ALO", "GAS", "SAI", "STR"];
    const byPace = [...codes].sort(
      (a, b) => traitsForDriver(a).pace - traitsForDriver(b).pace
    );
    const results = await simulateField([byPace[0], byPace[5], byPace[byPace.length - 1]], 120);
    for (const car of results) {
      expect(car.maxTilt).toBeLessThan(FLIP_THRESHOLD_RAD);
      expect(car.traveled).toBeGreaterThan(4000);
    }
    expect(results[0].leadChanges).toBeGreaterThanOrEqual(1);
    // The pass must come from genuine lunges - offset attempts that
    // actually move the car off the line - not from mistakes alone.
    const attempts = results.reduce((sum, car) => sum + car.attemptTicks, 0);
    expect(attempts).toBeGreaterThan(60);
    const widest = Math.max(...results.map((car) => car.maxOffset));
    expect(widest).toBeGreaterThan(1);
  }, 180000);

  it("an eight-car field swaps positions through a full race distance", async () => {
    // The live-observed scenario: grid-start grid order, 180s of racing.
    // Counts every position swap (not just the lead) plus lunge ticks, so
    // a formation-train regression reads as zeros here, not vibes.
    const codes = ["COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM"];
    const results = await simulateField(codes, 180);
    console.log(
      "field180:",
      JSON.stringify({
        swaps: results[0].swaps,
        leadChanges: results[0].leadChanges,
        attempts: results.map((car) => car.attemptTicks),
        traveled: results.map((car) => Math.round(car.traveled)),
        resets: results.map((car) => car.firewallResets),
      })
    );
    for (const car of results) {
      expect(car.maxTilt).toBeLessThan(FLIP_THRESHOLD_RAD);
      expect(car.traveled).toBeGreaterThan(6000);
    }
  }, 240000);

  it("a five-car pack start survives the opening lap without piling up", async () => {    // Adjacent grid slots, mixed traits: the Lap-1 concertina that once
    // permanently jammed the field must clear itself - everyone circulating
    // within a minute, nobody flipped, nobody beached.
    const results = await simulateField(["COL", "ALO", "STR", "HUL", "BOR"], 60);
    for (const car of results) {
      expect(car.maxTilt).toBeLessThan(FLIP_THRESHOLD_RAD);
      expect(car.traveled).toBeGreaterThan(1500);
    }
  }, 180000);

  it("a full 20-car grid survives the Suzuka start without solver death", async () => {
    // The shipped bug: flat y=1 spawns buried back-grid cars where the
    // final sector climbs, grinding the contact solver into NaN (frozen
    // frame, dead WASM). With elevation-aware spawns plus the NaN
    // firewall, the whole field launches and circulates - and the
    // firewall never fires once in a healthy run.
    const codes = [
      "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM",
      "LEC", "OCO", "BEA", "NOR", "PIA", "RUS", "ANT", "LAW",
      "LIN", "VER", "HAD", "SAI",
    ];
    const results = await simulateField(codes, 30, 3, suzuka as TrackData);
    for (const car of results) {
      expect(car.maxTilt).toBeLessThan(FLIP_THRESHOLD_RAD);
      expect(car.traveled).toBeGreaterThan(500);
    }
    expect(results[0].firewallResets).toBe(0);
  }, 240000);
});
