"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
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
  computeStabilizingTorque,
  createCarController,
} from "@/lib/physics/vehicle";
import { useDriveInput } from "@/lib/input/useDriveInput";
import { createLapTimer, formatLapTime } from "@/lib/race/lapTimer";
import { createRewindBuffer, type RewindSample } from "@/lib/race/rewindBuffer";

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
  trackId,
  startPos,
}: {
  chassisRef: React.RefObject<RapierRigidBody | null>;
  speedRef?: React.RefObject<HTMLDivElement | null>;
  lapRef?: React.RefObject<HTMLDivElement | null>;
  trackId: string;
  startPos: { x: number; z: number; headingRad: number };
}) {
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
    bestLapRef.current = loadBestLap(trackId);
  }, [trackId]);

  const rewindBufferRef = useRef(createRewindBuffer(REWIND_CAPACITY_SECONDS, 1 / 60));
  const rewindCursorRef = useRef(0);
  const wasRewindingRef = useRef(false);
  const isRewindingRef = useRef(false);

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

    applyCarControls(
      controller,
      driveInput,
      DEFAULT_ENGINE_FORCE,
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed()
    );
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }

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

    if (isRewindingRef.current) return;

    const t = body.translation();
    const lap = lapTimerRef.current.update({ x: t.x, z: t.z }, dt);
    if (
      lap.crossedFinishLine &&
      lap.lastLapSeconds !== null &&
      (bestLapRef.current === null || lap.lastLapSeconds < bestLapRef.current)
    ) {
      bestLapRef.current = lap.lastLapSeconds;
      saveBestLap(trackId, lap.lastLapSeconds);
    }
    if (lapRef?.current) {
      lapRef.current.textContent =
        `LAP ${lap.lapCount + 1}  ${formatLapTime(lap.currentLapSeconds)}` +
        `  BEST ${formatLapTime(bestLapRef.current)}`;
    }
  });

  return (
    <RigidBody
      ref={chassisRef}
      colliders="cuboid"
      mass={CHASSIS_MASS}
      position={[startPos.x, 1, startPos.z]}
      rotation={[0, startPos.headingRad, 0]}
      linearDamping={LINEAR_DAMPING}
      angularDamping={ANGULAR_DAMPING}
      canSleep={false}
    >
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
