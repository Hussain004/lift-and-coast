"use client";

import { useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { Car } from "./Car";
import { Track } from "./Track";
import silverstone from "@/data/tracks/silverstone.json";
import type { TrackData } from "@/lib/tracks/types";
import { GRASS_BELOW_TRACK_METERS } from "@/lib/tracks/mesh";

const track = silverstone as TrackData;

// Half of the box geometry's height below (see GRASS_BELOW_TRACK_METERS for
// why the ground surface isn't flush with the track trimesh).
const GROUND_HALF_HEIGHT = 0.5;

function Ground() {
  return (
    <RigidBody
      type="fixed"
      colliders="cuboid"
      friction={0.6}
      position={[0, -(GROUND_HALF_HEIGHT + GRASS_BELOW_TRACK_METERS), 0]}
    >
      <mesh receiveShadow>
        <boxGeometry args={[2500, GROUND_HALF_HEIGHT * 2, 2500]} />
        <meshStandardMaterial color="#2b2b2b" />
      </mesh>
    </RigidBody>
  );
}

function ChaseCamera({
  target,
}: {
  target: React.RefObject<RapierRigidBody | null>;
}) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3(0, 3, 8));
  const lookAt = useRef(new THREE.Vector3());
  const back = useRef(new THREE.Vector3());

  useFrame((_, dt) => {
    const body = target.current;
    if (!body) return;
    const t = body.translation();
    const r = body.rotation();
    // Yaw only - a chase camera rigidly following the chassis's full
    // rotation amplifies every bit of pitch/roll (suspension squat, kerb
    // bump, cornering lean) into a much larger swing of camera position,
    // since the offset arm is several meters long. A ~2 degree chassis
    // pitch under throttle was reading as a dramatic lurch in the view.
    const yaw = Math.atan2(
      2 * (r.w * r.y + r.x * r.z),
      1 - 2 * (r.y * r.y + r.z * r.z)
    );

    back.current.set(0, 2.2, 7).applyEuler(new THREE.Euler(0, yaw, 0));
    desiredPos.current.set(t.x + back.current.x, t.y + back.current.y, t.z + back.current.z);
    camera.position.lerp(desiredPos.current, Math.min(1, dt * 5));

    lookAt.current.lerp(new THREE.Vector3(t.x, t.y + 0.5, t.z), Math.min(1, dt * 8));
    camera.lookAt(lookAt.current);
  });

  return null;
}

export function Scene({
  speedRef,
  lapRef,
  trackLimitRef,
  energyRef,
  aeroModeRef,
}: {
  speedRef: React.RefObject<HTMLDivElement | null>;
  lapRef: React.RefObject<HTMLDivElement | null>;
  trackLimitRef: React.RefObject<HTMLDivElement | null>;
  energyRef: React.RefObject<HTMLDivElement | null>;
  aeroModeRef: React.RefObject<HTMLDivElement | null>;
}) {
  const chassisRef = useRef<RapierRigidBody>(null);

  return (
    <Canvas
      shadows
      camera={{
        fov: 65,
        position: [track.startPos.x, 3, track.startPos.z + 8],
        far: 3000,
      }}
    >
      <color attach="background" args={["#87ceeb"]} />
      <fog attach="fog" args={["#87ceeb", 40, 220]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 80, 20]} intensity={1.2} castShadow />
      <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60}>
        <Ground />
        <Track track={track} />
        <Car
          chassisRef={chassisRef}
          speedRef={speedRef}
          lapRef={lapRef}
          trackLimitRef={trackLimitRef}
          energyRef={energyRef}
          aeroModeRef={aeroModeRef}
          track={track}
        />
      </Physics>
      <ChaseCamera target={chassisRef} />
    </Canvas>
  );
}
