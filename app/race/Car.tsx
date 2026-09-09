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
  CAR_WHEELS,
  applyCarControls,
  computeStabilizingTorque,
  createCarController,
} from "@/lib/physics/vehicle";
import { useDriveInput } from "@/lib/input/useDriveInput";

const MAX_ENGINE_FORCE = 55;
const MAX_BRAKE_FORCE = 40;
const STABILIZE_STRENGTH = 30;

export function Car({
  chassisRef,
  speedRef,
  startPos,
}: {
  chassisRef: React.RefObject<RapierRigidBody | null>;
  speedRef?: React.RefObject<HTMLDivElement | null>;
  startPos: { x: number; z: number; headingRad: number };
}) {
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(
    null
  );
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const { world, rapier } = useRapier();
  const { update } = useDriveInput();

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
    applyCarControls(controller, driveInput, MAX_ENGINE_FORCE, MAX_BRAKE_FORCE);
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
  });

  useFrame(() => {
    const controller = controllerRef.current;
    if (!controller) return;
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
  });

  return (
    <RigidBody
      ref={chassisRef}
      colliders="cuboid"
      mass={220}
      position={[startPos.x, 1, startPos.z]}
      rotation={[0, startPos.headingRad, 0]}
      linearDamping={0.3}
      angularDamping={6}
      canSleep={false}
    >
      <mesh castShadow>
        <boxGeometry args={[1.8, 0.8, 4]} />
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
