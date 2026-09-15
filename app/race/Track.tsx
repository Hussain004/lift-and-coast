"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { RigidBody, TrimeshCollider } from "@react-three/rapier";
import { buildRibbonGeometry } from "@/lib/tracks/mesh";
import { computeRacingLine } from "@/lib/tracks/racingLine";
import type { TrackData } from "@/lib/tracks/types";

// Lifts the racing line's rendered geometry just above the flat (y=0) track
// surface (see mesh.ts's own comment) so it doesn't z-fight with it.
const RACING_LINE_HEIGHT_OFFSET = 0.05;

function RacingLine({ track }: { track: TrackData }) {
  const geometry = useMemo(() => {
    const points = computeRacingLine(track);
    const positions = new Float32Array(points.length * 3);
    points.forEach(([x, y, z], i) => {
      positions[i * 3] = x;
      positions[i * 3 + 1] = y + RACING_LINE_HEIGHT_OFFSET;
      positions[i * 3 + 2] = z;
    });

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }, [track]);

  return (
    // lineLoop (not <line>, which TypeScript resolves against the SVG DOM
    // element of the same name instead of R3F's three.js primitive) closes
    // the loop back to the first point on its own.
    <lineLoop geometry={geometry}>
      <lineBasicMaterial color="#ffd23f" />
    </lineLoop>
  );
}

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
    <>
      <RigidBody type="fixed" colliders={false} friction={1.3}>
        <TrimeshCollider args={[positions, indices]} />
        <mesh geometry={geometry} receiveShadow>
          <meshStandardMaterial color="#3a3a3a" />
        </mesh>
      </RigidBody>
      <RacingLine track={track} />
    </>
  );
}
