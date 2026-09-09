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
  applyCarControls,
  applyLoadSensitiveFriction,
  computeStabilizingTorque,
  createCarController,
} from "@/lib/physics/vehicle";
import { computeDownforceN } from "@/lib/physics/aero";
import { createEnergySystem } from "@/lib/physics/energy";
import { useDriveInput } from "@/lib/input/useDriveInput";
import { createLapTimer, formatLapTime } from "@/lib/race/lapTimer";
import { createRewindBuffer, type RewindSample } from "@/lib/race/rewindBuffer";
import { checkTrackLimits } from "@/lib/tracks/trackLimits";
import type { TrackData } from "@/lib/tracks/types";

const LINE_HALF_WIDTH_METERS = 6;
const REWIND_CAPACITY_SECONDS = 5;

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

function bestLapStorageKey(trackId: string) {
  return `lift-and-coast:best-lap:${trackId}`;
}

// ponytail: a single float per track doesn't need IndexedDB/schema
// versioning yet (plan section 10 calls for IndexedDB for personal bests
// long-term) - move it there once ghost replay/telemetry data needs that
// infra anyway, and migrate this key alongside it.
function loadBestLap(trackId: string): number | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(bestLapStorageKey(trackId));
  const parsed = raw === null ? null : Number(raw);
  return parsed !== null && Number.isFinite(parsed) ? parsed : null;
}

function saveBestLap(trackId: string, seconds: number) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(bestLapStorageKey(trackId), String(seconds));
}

const CHASSIS_SIZE: [number, number, number] = [
  CHASSIS_HALF_EXTENTS[0] * 2,
  CHASSIS_HALF_EXTENTS[1] * 2,
  CHASSIS_HALF_EXTENTS[2] * 2,
];

export function Car({
  chassisRef,
  speedRef,
  lapRef,
  trackLimitRef,
  energyRef,
  track,
}: {
  chassisRef: React.RefObject<RapierRigidBody | null>;
  speedRef?: React.RefObject<HTMLDivElement | null>;
  lapRef?: React.RefObject<HTMLDivElement | null>;
  trackLimitRef?: React.RefObject<HTMLDivElement | null>;
  energyRef?: React.RefObject<HTMLDivElement | null>;
  track: TrackData;
}) {
  const { startPos } = track;
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(
    null
  );
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const { world, rapier } = useRapier();
  const { update } = useDriveInput();
  const lapTimerRef = useRef(
    createLapTimer({ startPos, lineHalfWidth: LINE_HALF_WIDTH_METERS })
  );
  const bestLapRef = useRef<number | null>(null);
  useEffect(() => {
    bestLapRef.current = loadBestLap(track.id);
  }, [track.id]);

  const rewindBufferRef = useRef(createRewindBuffer(REWIND_CAPACITY_SECONDS, 1 / 60));
  const rewindCursorRef = useRef(0);
  const wasRewindingRef = useRef(false);
  const isRewindingRef = useRef(false);

  const energySystemRef = useRef(createEnergySystem());
  const batteryFractionRef = useRef(1);

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
          DEFAULT_BRAKE_FORCE,
          controller.currentVehicleSpeed()
        );
        applyLoadSensitiveFriction(controller);
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

    if (driveInput.rewind) {
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
      DEFAULT_ENGINE_FORCE * energyStatus.engineForceMultiplier,
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed()
    );
    applyLoadSensitiveFriction(controller);
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
    const downforceN = computeDownforceN(controller.currentVehicleSpeed());
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);

    rewindBufferRef.current.push(snapshotOf(body));
  });

  useFrame((_, dt) => {
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

    if (isRewindingRef.current) return;

    const t = body.translation();
    const lap = lapTimerRef.current.update({ x: t.x, z: t.z }, dt);
    if (
      lap.crossedFinishLine &&
      lap.lastLapSeconds !== null &&
      (bestLapRef.current === null || lap.lastLapSeconds < bestLapRef.current)
    ) {
      bestLapRef.current = lap.lastLapSeconds;
      saveBestLap(track.id, lap.lastLapSeconds);
    }
    if (lapRef?.current) {
      lapRef.current.textContent =
        `LAP ${lap.lapCount + 1}  ${formatLapTime(lap.currentLapSeconds)}` +
        `  BEST ${formatLapTime(bestLapRef.current)}`;
    }

    if (trackLimitRef?.current) {
      const status = checkTrackLimits(track, t.x, t.z);
      trackLimitRef.current.textContent = status.isOffTrack ? "TRACK LIMITS" : "";
    }
  });

  return (
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
      <mesh castShadow>
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
  );
}
