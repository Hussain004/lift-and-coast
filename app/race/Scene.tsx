"use client";

import { useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { Car } from "./Car";

function Ground() {
  return (
    <RigidBody type="fixed" colliders="cuboid" friction={1.4} position={[0, -0.5, 0]}>
      <mesh receiveShadow>
        <boxGeometry args={[400, 1, 400]} />
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
    const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);

    back.current.set(0, 2.2, 7).applyQuaternion(quat);
    desiredPos.current.set(t.x + back.current.x, t.y + back.current.y, t.z + back.current.z);
    camera.position.lerp(desiredPos.current, Math.min(1, dt * 5));

    lookAt.current.lerp(new THREE.Vector3(t.x, t.y + 0.5, t.z), Math.min(1, dt * 8));
    camera.lookAt(lookAt.current);
  });

  return null;
}

export function Scene({
  speedRef,
}: {
  speedRef: React.RefObject<HTMLDivElement | null>;
}) {
  const chassisRef = useRef<RapierRigidBody>(null);

  return (
    <Canvas shadows camera={{ fov: 65, position: [0, 3, 8] }}>
      <color attach="background" args={["#87ceeb"]} />
      <fog attach="fog" args={["#87ceeb", 40, 220]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[50, 80, 20]} intensity={1.2} castShadow />
      <Physics gravity={[0, -9.81, 0]} timeStep={1 / 60}>
        <Ground />
        <Car chassisRef={chassisRef} speedRef={speedRef} />
      </Physics>
      <ChaseCamera target={chassisRef} />
    </Canvas>
  );
}
