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
  target: React.RefObject<THREE.Object3D | null>;
}) {
  const { camera } = useThree();
  const desiredPos = useRef(new THREE.Vector3(0, 3, 8));
  const lookAt = useRef(new THREE.Vector3());
  const back = useRef(new THREE.Vector3());
  const worldPos = useRef(new THREE.Vector3());
  const worldQuat = useRef(new THREE.Quaternion());

  useFrame((_, dt) => {
    const object = target.current;
    if (!object) return;
    // Reads the chassis MESH's own interpolated world transform (see
    // visualRef in Car.tsx), not the raw physics body. react-three-rapier
    // smooths each RigidBody's rendered object between physics steps
    // (Physics defaults to interpolate: true) for visual stability at any
    // render framerate, but the raw rigid body always reports the latest
    // completed physics step - a camera built from the raw body disagreed
    // with what was actually on screen by up to one physics step's worth
    // of motion, on every render frame that didn't land exactly on a step
    // boundary. That gap is proportional to speed - invisible standing
    // still, worse the faster the car goes - which matches the reported
    // "galloping"/"steering out on its own" far better than anything
    // tried before: present even driving dead straight, a slight twitch
    // in high-downforce, much worse in low-drag (its higher top speed),
    // and impossible to reproduce in this project's headless harness,
    // which has no rendering pipeline and so no interpolation to disagree
    // with in the first place.
    object.getWorldPosition(worldPos.current);
    object.getWorldQuaternion(worldQuat.current);
    const t = worldPos.current;
    const r = worldQuat.current;
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
    // Exponential (not linear-per-frame) smoothing: a fixed fraction-of-gap-
    // closed-per-frame lerp is frame-rate dependent, so any render dt jitter
    // (a GC pause, a heavier draw call during a turn) gets amplified into a
    // visible camera swing proportional to how far the target just moved -
    // worst during cornering, when desiredPos/lookAt move the most per
    // frame. This closes the same fraction of the remaining gap regardless
    // of dt, and both position and lookAt now share one rate so they track
    // each other instead of drifting apart under irregular frame timing.
    const smoothing = 1 - Math.exp(-8 * dt);
    camera.position.lerp(desiredPos.current, smoothing);

    lookAt.current.lerp(new THREE.Vector3(t.x, t.y + 0.5, t.z), smoothing);
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
  const visualRef = useRef<THREE.Mesh>(null);

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
          visualRef={visualRef}
          speedRef={speedRef}
          lapRef={lapRef}
          trackLimitRef={trackLimitRef}
          energyRef={energyRef}
          aeroModeRef={aeroModeRef}
          track={track}
        />
      </Physics>
      <ChaseCamera target={visualRef} />
    </Canvas>
  );
}
