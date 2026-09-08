"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { RigidBody, TrimeshCollider } from "@react-three/rapier";
import { buildRibbonGeometry } from "@/lib/tracks/mesh";
import type { TrackData } from "@/lib/tracks/types";

export function Track({ track }: { track: TrackData }) {
  const { positions, indices, geometry } = useMemo(() => {
    const { positions, indices } = buildRibbonGeometry(track);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    return { positions, indices, geometry };
  }, [track]);

  return (
    <RigidBody type="fixed" colliders={false} friction={1.3}>
      <TrimeshCollider args={[positions, indices]} />
      <mesh geometry={geometry} receiveShadow>
        <meshStandardMaterial color="#3a3a3a" />
      </mesh>
    </RigidBody>
  );
}
