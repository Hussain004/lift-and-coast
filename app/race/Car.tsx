"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  CuboidCollider,
  RigidBody,
  useRapier,
  useBeforePhysicsStep,
  type RapierRigidBody,
} from "@react-three/rapier";
import type Rapier from "@dimforge/rapier3d-compat";
import {
  ANGULAR_DAMPING,
  CAR_WHEELS,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  LINEAR_DAMPING,
  OFF_TRACK_RESET_METERS,
  WORLD_EDGE_RESET_METERS,
  applyCarControls,
  applyDragImpulse,
  applyLoadSensitiveFriction,
  computeStabilizingTorque,
  createCarController,
  yawFromQuaternion,
} from "@/lib/physics/vehicle";
import { computeDownforceN } from "@/lib/physics/aero";
import { createEnergySystem } from "@/lib/physics/energy";
import { TIRE_COMPOUNDS, computeCompoundGripMultiplier, type TireCompoundId } from "@/lib/physics/tireModel";
import { useDriveInput, type CameraMode } from "@/lib/input/useDriveInput";
import { createLapTimer, formatLapTime } from "@/lib/race/lapTimer";
import { createDeltaTracker, formatDelta } from "@/lib/race/deltaTimer";
import { createGhostRecorder } from "@/lib/race/ghostRecorder";
import { createSectorTimer, type SectorCrossing, type SectorColor } from "@/lib/race/sectorTimer";
import { createRewindBuffer, type RewindSample } from "@/lib/race/rewindBuffer";
import { loadPersonalBest, savePersonalBest } from "@/lib/persistence/personalBests";
import {
  allWheelsOffTrack,
  checkTrackLimits,
  computeSurfaceGripMultiplier,
} from "@/lib/tracks/trackLimits";
import { computeSectorGates } from "@/lib/tracks/sectors";
import { computeMinimapTransform } from "@/lib/tracks/minimap";
import type { TrackData } from "@/lib/tracks/types";

const LINE_HALF_WIDTH_METERS = 6;
const REWIND_CAPACITY_SECONDS = 5;
const SECTOR_COUNT = 3;
const SECTOR_COLOR_HEX: Record<SectorColor, string> = {
  purple: "#b967ff",
  green: "#39ff88",
  yellow: "#ffd23f",
};

function snapshotOf(body: RapierRigidBody): RewindSample {
  const p = body.translation();
  const r = body.rotation();
  const lv = body.linvel();
  const av = body.angvel();
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
    linvel: { x: lv.x, y: lv.y, z: lv.z },
    angvel: { x: av.x, y: av.y, z: av.z },
  };
}

function applySnapshot(body: RapierRigidBody, sample: RewindSample, zeroVelocity: boolean) {
  body.setTranslation(sample.position, true);
  body.setRotation(sample.rotation, true);
  body.setLinvel(zeroVelocity ? { x: 0, y: 0, z: 0 } : sample.linvel, true);
  body.setAngvel(zeroVelocity ? { x: 0, y: 0, z: 0 } : sample.angvel, true);
}

const CHASSIS_SIZE: [number, number, number] = [
  CHASSIS_HALF_EXTENTS[0] * 2,
  CHASSIS_HALF_EXTENTS[1] * 2,
  CHASSIS_HALF_EXTENTS[2] * 2,
];

export function Car({
  chassisRef,
  visualRef,
  cameraModeRef,
  speedRef,
  lapRef,
  deltaRef,
  sectorsRef,
  trackLimitRef,
  energyRef,
  aeroModeRef,
  tireRef,
  assistsRef,
  minimapGroupRef,
  minimapMarkerRef,
  track,
}: {
  chassisRef: React.RefObject<RapierRigidBody | null>;
  /**
   * A ref to the chassis mesh itself, not the physics body - see its usage
   * site in Scene.tsx for why the chase camera needs this instead of
   * chassisRef.
   */
  visualRef?: React.RefObject<THREE.Mesh | null>;
  /**
   * Shared with Scene.tsx's camera component (see useDriveInput's own
   * comment for why) - created there and passed down so both this
   * component's keyboard handling and the camera outside it read the same
   * ref.
   */
  cameraModeRef?: React.RefObject<CameraMode>;
  speedRef?: React.RefObject<HTMLDivElement | null>;
  lapRef?: React.RefObject<HTMLDivElement | null>;
  deltaRef?: React.RefObject<HTMLDivElement | null>;
  sectorsRef?: React.RefObject<HTMLDivElement | null>;
  trackLimitRef?: React.RefObject<HTMLDivElement | null>;
  energyRef?: React.RefObject<HTMLDivElement | null>;
  aeroModeRef?: React.RefObject<HTMLDivElement | null>;
  tireRef?: React.RefObject<HTMLDivElement | null>;
  assistsRef?: React.RefObject<HTMLDivElement | null>;
  minimapGroupRef?: React.RefObject<SVGGElement | null>;
  minimapMarkerRef?: React.RefObject<SVGPolygonElement | null>;
  track: TrackData;
}) {
  const { startPos } = track;
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(
    null
  );
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const { world, rapier } = useRapier();
  const { update, aeroMode, cameraMode, tireCompound, tractionControlEnabled, absEnabled } =
    useDriveInput(cameraModeRef);
  const lapTimerRef = useRef(
    createLapTimer({ startPos, lineHalfWidth: LINE_HALF_WIDTH_METERS })
  );
  const bestLapRef = useRef<number | null>(null);
  const deltaTrackerRef = useRef(createDeltaTracker());
  // Set whenever this lap's progress jumped discontinuously (a rewind, or
  // the off-track teleport below) instead of driving forward continuously -
  // such a lap's recorded (progress, time) samples aren't monotonic, so it
  // must never be adopted as the delta tracker's reference lap even if it
  // happens to also be a new best time (recordSample/endLap in
  // lib/race/deltaTimer.ts assume monotonic progress within a recording).
  // Reset after every lap ends, tainting only the lap it happened in.
  const lapHadDiscontinuityRef = useRef(false);
  // Plan section 5, depth feature 7: a lap is invalidated once all four
  // wheels have been off track at any point, not just momentarily flagged
  // by the real-time HUD warning (which fires off the chassis center - see
  // allWheelsOffTrack's own comment for why the two use different rules).
  // Reset alongside lapHadDiscontinuityRef when the next lap starts.
  const lapInvalidRef = useRef(false);
  // The lap clock's value (lap.currentLapSeconds) at the moment
  // lapInvalidRef first became true this lap - lets the rewind-resume
  // handler below tell whether a rewind reached back far enough to undo
  // the actual violation, not just any rewind at all (which would let an
  // unrelated later correction erase an earlier, still-valid infraction).
  const lapInvalidAtSecondsRef = useRef<number | null>(null);
  const sectorTimerRef = useRef(createSectorTimer(computeSectorGates(track, SECTOR_COUNT)));
  const sectorResultsRef = useRef<(SectorCrossing | null)[]>(
    new Array(SECTOR_COUNT).fill(null)
  );
  const ghostRecorderRef = useRef(createGhostRecorder());
  const ghostMeshRef = useRef<THREE.Mesh>(null);
  // Distance driven (odometer-style, direction-independent) since the
  // current compound was fitted - see computeCompoundGripMultiplier in
  // tireModel.ts. Not lap-scoped: real tire wear accumulates across a
  // whole stint, not per lap, and this project has no pit-stop system yet
  // to force a reset - switching compounds (the 1/2/3 keys, owned by
  // useDriveInput) is the only reset trigger, standing in for fitting a
  // fresh set. Deliberately NOT touched by rewind or the off-track
  // teleport reset - both roll back POSITION/TIME, but the tires
  // physically experienced those meters regardless, same as a real
  // rewind not un-scrubbing tire wear. Pressing the SAME compound's key
  // again while already on it is a no-op (change-detected below, not
  // event-detected) - there's no way to "re-fit an identical fresh set"
  // without switching away and back, a known, minor limitation.
  const tireWornMetersRef = useRef(0);
  // Last compound seen, to detect a change made via the 1/2/3 keys (owned
  // by useDriveInput, see tireCompound above) and reset wear on switch -
  // the wear tracking itself lives here rather than in useDriveInput
  // since it needs per-frame speed/distance data that hook doesn't have.
  const prevTireCompoundRef = useRef<TireCompoundId>(tireCompound.current);
  useEffect(() => {
    let cancelled = false;
    loadPersonalBest(track.id)
      .then((record) => {
        if (cancelled || !record) return;
        bestLapRef.current = record.bestLapSeconds;
        if (record.ghost.length > 0) ghostRecorderRef.current.setReference(record.ghost);
      })
      .catch(() => {});
    // Shows "S1 --.---  S2 --.---  S3 --.---" from the very start of the
    // session, rather than a blank/hidden HUD element (.sectors:empty)
    // until the first sector completes.
    renderSectors();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const rewindBufferRef = useRef(createRewindBuffer(REWIND_CAPACITY_SECONDS, 1 / 60));
  const rewindCursorRef = useRef(0);
  const wasRewindingRef = useRef(false);
  const isRewindingRef = useRef(false);

  const energySystemRef = useRef(createEnergySystem());
  const batteryFractionRef = useRef(1);
  const startRotationRef = useRef(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, startPos.headingRad, 0))
  );

  useEffect(() => {
    const body = chassisRef.current;
    if (!body) return;
    const controller = createCarController(rapier, world, body);
    controllerRef.current = controller;
    return () => {
      world.removeVehicleController(controller);
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rapier, world]);

  // Diagnostic hook, kept deliberately: runs a batch of physics steps
  // synchronously against the real mounted world/controller/chassis,
  // bypassing the render loop entirely. In the Claude Code browser
  // automation used to build this, requestAnimationFrame and
  // ResizeObserver never fire, so this - plus dispatching a plain
  // `resize` event on window once to unstick react-use-measure's initial
  // container measurement, which is what the Canvas mount itself is
  // gated on - is the only way to mount the scene and then inspect the
  // live game's actual physics state from there. This is how the wheel
  // mesh auto-collider bug below was actually found: the headless Node
  // harness has no meshes at all and could never have seen it.
  useEffect(() => {
    function handleDebugDrive(event: Event) {
      const controller = controllerRef.current;
      const body = chassisRef.current;
      const output = document.getElementById("__debug-output");
      if (!controller || !body) {
        if (output) {
          output.textContent = JSON.stringify({
            error: "controller or body not ready",
            hasController: !!controller,
            hasBody: !!body,
          });
        }
        return;
      }
      if (output) output.textContent = "RUNNING";
      const detail = (event as CustomEvent).detail as {
        seconds: number;
        throttle: number;
        brake: number;
        steer: number;
        sampleEvery?: number;
      };
      const timestep = world.timestep;
      const steps = Math.round(detail.seconds / timestep);
      const sampleEvery = detail.sampleEvery ?? 30;
      const worldUp = new THREE.Vector3(0, 1, 0);
      let maxTilt = 0;
      const samples: Array<{
        t: number;
        tilt: number;
        roll: number;
        pitch: number;
        y: number;
        speed: number;
      }> = [];

      for (let i = 0; i < steps; i++) {
        applyCarControls(
          controller,
          { throttle: detail.throttle, brake: detail.brake, steer: detail.steer },
          DEFAULT_ENGINE_FORCE,
          1,
          DEFAULT_BRAKE_FORCE,
          controller.currentVehicleSpeed(),
          true
        );
        applyLoadSensitiveFriction(controller, aeroMode.current);
        controller.updateVehicle(timestep);

        const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
        if (torque[0] || torque[1] || torque[2]) {
          body.applyTorqueImpulse(
            { x: torque[0] * timestep, y: torque[1] * timestep, z: torque[2] * timestep },
            true
          );
        }
        const downforceN = computeDownforceN(controller.currentVehicleSpeed());
        body.applyImpulse({ x: 0, y: -downforceN * timestep, z: 0 }, true);
        applyDragImpulse(body, aeroMode.current, timestep);

        world.step();

        const r = body.rotation();
        const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
        const tilt = bodyUp.angleTo(worldUp);
        if (tilt > maxTilt) maxTilt = tilt;

        if (i % sampleEvery === 0) {
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
          samples.push({
            t: Number((i * timestep).toFixed(2)),
            tilt: Number(tilt.toFixed(4)),
            roll: Number(Math.asin(Math.max(-1, Math.min(1, bodyRight.y))).toFixed(4)),
            pitch: Number(Math.asin(Math.max(-1, Math.min(1, -bodyForward.y))).toFixed(4)),
            y: Number(body.translation().y.toFixed(4)),
            speed: Number(controller.currentVehicleSpeed().toFixed(2)),
          });
        }
      }

      if (output) {
        output.textContent = JSON.stringify({ bodyMass: body.mass(), maxTilt, samples });
      }
    }

    window.addEventListener("debug-drive-request", handleDebugDrive);
    return () => window.removeEventListener("debug-drive-request", handleDebugDrive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
    const driveInput = update(world.timestep);
    isRewindingRef.current = driveInput.rewind;

    // Snap back to the start line if the car ends up this far off-track
    // (e.g. spun off pointing away from the circuit and held throttle
    // instead of rewinding). Found via headless testing: driving straight
    // off-course for long enough eventually runs past the finite ground
    // plane's edge and crashes the physics engine entirely - this catches it
    // hundreds of meters before that, and far past any legitimate
    // spin-recovery distance in the stability suite (under 60m throughout).
    //
    // Also checks absolute distance from the origin directly (see
    // WORLD_EDGE_RESET_METERS) - the ribbon-distance check above can't catch
    // a car that drives straight past the far end of the track's own extent,
    // since the nearest ribbon point stays fixed while the car keeps going.
    const pos = body.translation();
    // Reused below for the surface grip penalty too, instead of a second
    // brute-force nearest-centerline-point scan for the same position.
    const limitStatus = checkTrackLimits(track, pos.x, pos.z);
    if (
      limitStatus.distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > WORLD_EDGE_RESET_METERS
    ) {
      const q = startRotationRef.current;
      body.setTranslation({ x: startPos.x, y: 1, z: startPos.z }, true);
      body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      // Clear rewind state too - otherwise a reset that lands mid-rewind
      // (holding R while 300m out, the exact situation a stranded player
      // reaches for) leaves wasRewindingRef true, and the next tick's
      // resumeFrom() teleports the car straight back out to the stale
      // pre-reset snapshot.
      wasRewindingRef.current = false;
      rewindCursorRef.current = 0;
      lapHadDiscontinuityRef.current = true;
      // Otherwise nextGateIndex would still point at whatever gate was
      // being approached before the teleport - the car driving from the
      // start line would silently miss gate 0 and later register a
      // garbage split spanning the teleport (see sectorTimer.reset).
      sectorTimerRef.current.reset();
      return;
    }

    if (driveInput.rewind) {
      lapHadDiscontinuityRef.current = true;
      wasRewindingRef.current = true;
      const buffer = rewindBufferRef.current;
      rewindCursorRef.current = Math.min(
        rewindCursorRef.current + world.timestep,
        buffer.oldestAvailableSeconds()
      );
      const sample = buffer.sampleAt(rewindCursorRef.current);
      if (sample) applySnapshot(body, sample, true);
      return;
    }

    if (wasRewindingRef.current) {
      const sample = rewindBufferRef.current.resumeFrom(rewindCursorRef.current);
      if (sample) applySnapshot(body, sample, false);
      // Undo the mistake, not just its consequences: roll the lap clock
      // back by however much time was actually scrubbed. Only clear an
      // existing track-limits invalidation if the rollback actually
      // reaches back to (or before) the moment it happened - otherwise an
      // unrelated later rewind (e.g. straightening up after clipping a
      // kerb at turn 9) would erase an earlier, still-legitimate
      // invalidation from turn 3 just by being a rewind at all. If the
      // excursion itself is still within reach after rewinding, the very
      // next frame's allWheelsOffTrack check re-flags it immediately
      // regardless. (lapHadDiscontinuityRef is deliberately NOT cleared
      // here - it protects the delta timer/ghost recorder's recorded
      // samples, which stay non-monotonic across this rewind regardless of
      // whether the driving itself was clean afterward.)
      const rolledBackTo = lapTimerRef.current.rewindBy(rewindCursorRef.current);
      if (lapInvalidAtSecondsRef.current === null || rolledBackTo <= lapInvalidAtSecondsRef.current) {
        lapInvalidRef.current = false;
        lapInvalidAtSecondsRef.current = null;
      }
      rewindCursorRef.current = 0;
      wasRewindingRef.current = false;
    }

    const energyStatus = energySystemRef.current.update(
      { brakeAmount: driveInput.brake, deployRequested: driveInput.deploy },
      world.timestep
    );
    batteryFractionRef.current = energyStatus.batteryFraction;

    applyCarControls(
      controller,
      driveInput,
      DEFAULT_ENGINE_FORCE,
      energyStatus.engineForceMultiplier,
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed(),
      tractionControlEnabled.current
    );

    // A fresh set is fitted the instant the player switches compounds
    // (1/2/3 keys, owned by useDriveInput) - see tireWornMetersRef's own
    // comment for why that's the only reset trigger this project has
    // right now.
    if (tireCompound.current !== prevTireCompoundRef.current) {
      prevTireCompoundRef.current = tireCompound.current;
      tireWornMetersRef.current = 0;
    }
    // Odometer-style accumulation using this step's pre-update speed - a
    // one-step lag against the exact instantaneous speed, immaterial at
    // 60Hz for a quantity that only meaningfully changes over many meters.
    tireWornMetersRef.current += Math.abs(controller.currentVehicleSpeed()) * world.timestep;
    const compoundGripMultiplier = computeCompoundGripMultiplier(
      TIRE_COMPOUNDS[tireCompound.current],
      tireWornMetersRef.current
    );
    const surfaceGripMultiplier = computeSurfaceGripMultiplier(limitStatus.distanceFromEdgeMeters);
    applyLoadSensitiveFriction(controller, aeroMode.current, compoundGripMultiplier, surfaceGripMultiplier);
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), aeroMode.current);
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(body, aeroMode.current, world.timestep);

    rewindBufferRef.current.push(snapshotOf(body));
  });

  function renderSectors() {
    if (!sectorsRef?.current) return;
    sectorsRef.current.innerHTML = sectorResultsRef.current
      .map((s, i) =>
        s
          ? `<span style="color:${SECTOR_COLOR_HEX[s.color]}">S${i + 1} ${s.sectorSeconds.toFixed(3)}</span>`
          : `<span>S${i + 1} --.---</span>`
      )
      .join("");
  }

  useFrame((_, dt) => {
    // Hide the chassis mesh in cockpit mode - otherwise the camera (see
    // ChaseCamera in Scene.tsx) sits inside a solid box and renders its
    // inside faces. Cheaper and more robust than offsetting the camera
    // just ahead of the chassis, which would still clip through on a hard
    // pitch/roll. Runs before the controller/body guard below so a
    // transient null (a remount, a track change) while in cockpit mode
    // can't leave the car permanently invisible with nothing left to
    // restore it.
    if (visualRef?.current) {
      visualRef.current.visible = cameraMode.current !== "cockpit";
    }

    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
    CAR_WHEELS.forEach((wheel, i) => {
      const steerGroup = steerRefs.current[i];
      const spinGroup = spinRefs.current[i];
      if (steerGroup && wheel.isSteering) {
        steerGroup.rotation.y = controller.wheelSteering(i) ?? 0;
      }
      if (spinGroup) {
        spinGroup.rotation.x = controller.wheelRotation(i) ?? 0;
      }
    });
    if (speedRef?.current) {
      const kmh = Math.abs(controller.currentVehicleSpeed()) * 3.6;
      speedRef.current.textContent = `${Math.round(kmh)} km/h`;
    }
    if (energyRef?.current) {
      energyRef.current.style.width = `${(batteryFractionRef.current * 100).toFixed(1)}%`;
    }
    if (aeroModeRef?.current) {
      aeroModeRef.current.textContent =
        aeroMode.current === "low-drag" ? "LOW DRAG" : "HIGH DOWNFORCE";
    }
    if (tireRef?.current) {
      const gripPercent = Math.round(
        computeCompoundGripMultiplier(TIRE_COMPOUNDS[tireCompound.current], tireWornMetersRef.current) *
          100
      );
      tireRef.current.textContent = `${tireCompound.current.toUpperCase()} ${gripPercent}%`;
    }
    if (assistsRef?.current) {
      assistsRef.current.textContent =
        `TC ${tractionControlEnabled.current ? "ON" : "OFF"}` +
        `  ABS ${absEnabled.current ? "ON" : "OFF"}`;
    }

    if (isRewindingRef.current) return;

    const t = body.translation();
    const status = checkTrackLimits(track, t.x, t.z);
    const lap = lapTimerRef.current.update({ x: t.x, z: t.z }, dt);
    const eligible = !lapHadDiscontinuityRef.current && !lapInvalidRef.current;
    if (lap.crossedFinishLine && lap.lastLapSeconds !== null) {
      const wasNewBest =
        eligible && (bestLapRef.current === null || lap.lastLapSeconds < bestLapRef.current);
      if (wasNewBest) {
        bestLapRef.current = lap.lastLapSeconds;
      }
      deltaTrackerRef.current.endLap(lap.lastLapSeconds, track.lengthMeters, wasNewBest);
      // Same eligibility as the delta timer's reference (see its own
      // endLap comment) - the ghost should be the same lap the delta is
      // measured against, not a separately-chosen one.
      ghostRecorderRef.current.endLap(wasNewBest);
      if (wasNewBest) {
        // After endLap above, so getReference() reflects this lap's just-
        // promoted ghost samples rather than the previous best's.
        savePersonalBest(track.id, {
          schemaVersion: 1,
          bestLapSeconds: lap.lastLapSeconds,
          ghost: ghostRecorderRef.current.getReference() ?? [],
        }).catch(() => {});
      }
      // Completes the final sector for the lap that just ended (see
      // sectorTimer.ts's own comment for why this is driven by the lap
      // timer's crossing rather than a third progress-based gate). The
      // display is deliberately NOT cleared here - the just-finished
      // lap's three splits stay on screen (S3 is otherwise never visible
      // at all, since it completes at the exact instant the lap ends) and
      // each slot is naturally overwritten as the new lap's own sectors
      // complete in turn.
      const finalSplit = sectorTimerRef.current.onLapEnd(lap.lastLapSeconds, eligible, wasNewBest);
      sectorResultsRef.current[finalSplit.sectorIndex] = finalSplit;
      renderSectors();
      lapHadDiscontinuityRef.current = false;
      lapInvalidRef.current = false;
      lapInvalidAtSecondsRef.current = null;
    }

    const sectorCrossing = sectorTimerRef.current.update(t.x, t.z, lap.currentLapSeconds, eligible);
    if (sectorCrossing) {
      sectorResultsRef.current[sectorCrossing.sectorIndex] = sectorCrossing;
      renderSectors();
    }

    // All-four-wheels-off check for lap invalidation (see allWheelsOffTrack)
    // - separate from and stricter than the chassis-center-based warning
    // below, so this only flags once the car has genuinely left the track,
    // not while merely running wide with grip still on one side.
    const bodyRot = body.rotation();
    const bodyQuat = new THREE.Quaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
    const wheelWorldPositions = CAR_WHEELS.map((wheel) => {
      const local = new THREE.Vector3(...wheel.position).applyQuaternion(bodyQuat);
      return { x: t.x + local.x, z: t.z + local.z };
    });
    if (allWheelsOffTrack(track, wheelWorldPositions)) {
      // Only record the timestamp on the first violation this lap - a
      // rewind must reach back to the START of the infraction to undo it,
      // not just its most recent moment.
      if (!lapInvalidRef.current) {
        lapInvalidAtSecondsRef.current = lap.currentLapSeconds;
      }
      lapInvalidRef.current = true;
    }

    if (lapRef?.current) {
      lapRef.current.textContent =
        `LAP ${lap.lapCount + 1}  ${formatLapTime(lap.currentLapSeconds)}` +
        `  BEST ${formatLapTime(bestLapRef.current)}` +
        (lapInvalidRef.current ? "  INVALID" : "");
    }

    const delta = deltaTrackerRef.current.recordSample(status.progressMeters, lap.currentLapSeconds);
    if (deltaRef?.current) {
      deltaRef.current.textContent = formatDelta(delta);
      deltaRef.current.dataset.sign = delta === null || delta === 0 ? "" : delta > 0 ? "behind" : "ahead";
    }

    ghostRecorderRef.current.recordSample(lap.currentLapSeconds, {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: bodyRot.x, y: bodyRot.y, z: bodyRot.z, w: bodyRot.w },
    });
    if (ghostMeshRef.current) {
      const ghostPose = ghostRecorderRef.current.poseAt(lap.currentLapSeconds);
      if (ghostPose) {
        ghostMeshRef.current.visible = true;
        ghostMeshRef.current.position.set(ghostPose.position.x, ghostPose.position.y, ghostPose.position.z);
        ghostMeshRef.current.quaternion.set(
          ghostPose.rotation.x,
          ghostPose.rotation.y,
          ghostPose.rotation.z,
          ghostPose.rotation.w
        );
      } else {
        ghostMeshRef.current.visible = false;
      }
    }

    if (trackLimitRef?.current) {
      trackLimitRef.current.textContent = status.isOffTrack ? "TRACK LIMITS" : "";
    }

    if (minimapGroupRef?.current) {
      const yaw = yawFromQuaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
      minimapGroupRef.current.setAttribute("transform", computeMinimapTransform(t.x, t.z, yaw));
    }
    if (minimapMarkerRef?.current) {
      minimapMarkerRef.current.setAttribute("fill", status.isOffTrack ? "#ff3b3b" : "#39ff88");
    }
  });

  return (
    <>
      <mesh ref={ghostMeshRef} visible={false}>
        <boxGeometry args={CHASSIS_SIZE} />
        <meshStandardMaterial color="#39ff88" transparent opacity={0.3} depthWrite={false} />
      </mesh>
      <RigidBody
        ref={chassisRef}
        colliders={false}
        position={[startPos.x, 1, startPos.z]}
        rotation={[0, startPos.headingRad, 0]}
        linearDamping={LINEAR_DAMPING}
        angularDamping={ANGULAR_DAMPING}
        canSleep={false}
      >
        {/*
          colliders={false} + one explicit collider is deliberate: the
          default auto-collider generation ("cuboid") walks every visible
          mesh under this RigidBody and gives EACH one its own bounding-box
          collider - including the 4 wheel cylinder meshes below, which were
          silently getting solid, chassis-fixed collision boxes sitting right
          where the ground is, fighting the raycast suspension on every wheel.
          That was the real cause of the violent launching/flipping reported
          during play - a headless harness with no meshes at all could never
          have caught it. Only the chassis body should ever be solid.
        */}
        <CuboidCollider args={CHASSIS_HALF_EXTENTS} mass={CHASSIS_MASS} />
        <mesh ref={visualRef} castShadow>
          <boxGeometry args={CHASSIS_SIZE} />
          <meshStandardMaterial color="#39ff88" />
        </mesh>
        {CAR_WHEELS.map((wheel, i) => (
          <group key={i} position={wheel.position}>
            <group ref={(el) => { steerRefs.current[i] = el; }}>
              <group ref={(el) => { spinRefs.current[i] = el; }}>
                <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                  <cylinderGeometry args={[wheel.radius, wheel.radius, 0.28, 16]} />
                  <meshStandardMaterial color="#111111" />
                </mesh>
              </group>
            </group>
          </group>
        ))}
      </RigidBody>
    </>
  );
}
