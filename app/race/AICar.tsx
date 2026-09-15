"use client";

import { useEffect, useMemo, useRef } from "react";
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
  computeSignedForwardSpeed,
  computeStabilizingTorque,
  createCarController,
  yawFromQuaternion,
} from "@/lib/physics/vehicle";
import { computeDownforceN } from "@/lib/physics/aero";
import { checkTrackLimits, computeSurfaceGripMultiplier } from "@/lib/tracks/trackLimits";
import { computeRacingLine } from "@/lib/tracks/racingLine";
import { computeAIControls } from "@/lib/ai/pathFollower";
import { createLapTimer, LINE_HALF_WIDTH_METERS } from "@/lib/race/lapTimer";
import type { RaceState } from "@/lib/race/racePosition";
import type { TrackData } from "@/lib/tracks/types";

const CHASSIS_SIZE: [number, number, number] = [
  CHASSIS_HALF_EXTENTS[0] * 2,
  CHASSIS_HALF_EXTENTS[1] * 2,
  CHASSIS_HALF_EXTENTS[2] * 2,
];

// Lateral offset from the player's own grid slot (Car.tsx spawns at
// startPos directly) so the two cars don't spawn overlapping - a fraction
// of the track's own half-width at the start line rather than a fixed
// distance, so it scales across tracks of different widths and stays well
// clear of computeSurfaceGripMultiplier's edge penalty (checked against
// Silverstone: 13m width, so this lands about 2.3m off the centerline,
// nowhere near the edge).
const GRID_OFFSET_FRACTION_OF_HALF_WIDTH = 0.35;

/**
 * A single AI opponent (plan section 6): follows the same ideal-line
 * approximation drawn for the player (lib/tracks/racingLine.ts) using
 * pure-pursuit steering and curvature-derived speed targets
 * (lib/ai/pathFollower.ts), running the identical vehicle rig as the
 * player's own car (Car.tsx) so it's bound by the same physics. No
 * racecraft, no opponent awareness, no difficulty tiers, no lap timing for
 * itself yet - groundwork for a race weekend, not one.
 *
 * Deliberately owns its own chassis/visual/controller refs rather than
 * sharing anything with Scene.tsx's player refs - ChaseCamera follows
 * Scene.tsx's visualRef, and this car must never become that target.
 *
 * Does track its own lap count now (plan section 7's Quick Race), writing
 * into the shared raceRef so Car.tsx can compute a live P1/P2 without
 * either car needing a ref into the other's internals.
 */
export function AICar({ track, raceRef }: { track: TrackData; raceRef?: React.RefObject<RaceState> }) {
  const { world, rapier } = useRapier();
  const chassisRef = useRef<RapierRigidBody>(null);
  const visualRef = useRef<THREE.Mesh>(null);
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(null);
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const lapTimerRef = useRef(
    createLapTimer({ startPos: track.startPos, lineHalfWidth: LINE_HALF_WIDTH_METERS })
  );

  const racingLine = useMemo(() => computeRacingLine(track), [track]);

  const { spawnX, spawnZ, spawnQuat } = useMemo(() => {
    const halfWidth = track.width[0] / 2;
    const offset = halfWidth * GRID_OFFSET_FRACTION_OF_HALF_WIDTH;
    const yaw = track.startPos.headingRad;
    // Forward at yaw (see yawFromQuaternion), "right" perpendicular to it -
    // same convention as mesh.ts/racingLine.ts's own right vectors.
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = -forwardZ;
    const rightZ = forwardX;
    return {
      spawnX: track.startPos.x + rightX * offset,
      spawnZ: track.startPos.z + rightZ * offset,
      spawnQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    };
  }, [track]);

  useEffect(() => {
    const body = chassisRef.current;
    if (!body) return;
    const controller = createCarController(rapier, world, body);
    controllerRef.current = controller;
    return () => {
      world.removeVehicleController(controller);
      controllerRef.current = null;
    };
  }, [rapier, world]);

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;

    const pos = body.translation();
    const limitStatus = checkTrackLimits(track, pos.x, pos.z);
    // Same safety backstop as the player's car (Car.tsx) - without it, a
    // path-follower bug or a bad launch could leave the AI stuck off-course
    // or run it past the finite ground plane's edge for the rest of the
    // session with nothing to recover it.
    if (
      limitStatus.distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > WORLD_EDGE_RESET_METERS
    ) {
      body.setTranslation({ x: spawnX, y: 1, z: spawnZ }, true);
      body.setRotation({ x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }

    const lap = lapTimerRef.current.update({ x: pos.x, z: pos.z }, world.timestep);
    if (raceRef?.current) {
      raceRef.current.ai = { lapCount: lap.lapCount, progressMeters: limitStatus.progressMeters };
    }

    const rot = body.rotation();
    const yaw = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
    // Not controller.currentVehicleSpeed() - see computeSignedForwardSpeed's
    // own comment for why that reads the wrong sign at sustained high speed
    // on the real trimesh, which would otherwise feed garbage into both the
    // path follower's target-speed logic and applyCarControls' steer-scale/
    // traction-control gating.
    const speedMs = computeSignedForwardSpeed(body.linvel(), yaw);
    const controls = computeAIControls(racingLine, pos.x, pos.z, yaw, speedMs);

    applyCarControls(controller, controls, DEFAULT_ENGINE_FORCE, 1, DEFAULT_BRAKE_FORCE, speedMs, true);

    const surfaceGripMultiplier = computeSurfaceGripMultiplier(limitStatus.distanceFromEdgeMeters);
    applyLoadSensitiveFriction(controller, "high-downforce", 1, surfaceGripMultiplier);
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), "high-downforce");
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(body, "high-downforce", world.timestep);
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
  });

  return (
    <RigidBody
      ref={chassisRef}
      colliders={false}
      position={[spawnX, 1, spawnZ]}
      rotation={[0, track.startPos.headingRad, 0]}
      linearDamping={LINEAR_DAMPING}
      angularDamping={ANGULAR_DAMPING}
      canSleep={false}
    >
      {/* colliders={false} + one explicit collider - see Car.tsx's own
          comment for why the auto-collider generation is unsafe here. */}
      <CuboidCollider args={CHASSIS_HALF_EXTENTS} mass={CHASSIS_MASS} />
      <mesh ref={visualRef} castShadow>
        <boxGeometry args={CHASSIS_SIZE} />
        <meshStandardMaterial color="#ff5a3c" />
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
