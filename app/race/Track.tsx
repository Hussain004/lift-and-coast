"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { RigidBody, TrimeshCollider } from "@react-three/rapier";
import { buildRibbonGeometry } from "@/lib/tracks/mesh";
import { buildRacingLineRibbon, computeRacingLine, type ThrottleZone } from "@/lib/tracks/racingLine";
import type { TrackData } from "@/lib/tracks/types";

// Lifts the racing line's rendered geometry just above the flat (y=0) track
// surface (see mesh.ts's own comment) so it doesn't z-fight with it.
const RACING_LINE_HEIGHT_OFFSET = 0.05;
// Wide colored stripe (like an F1 game's throttle map), not a thin wire -
// half this value each side of the line's own center.
const RACING_LINE_HALF_WIDTH_METERS = 1.3;

// 0-1 RGB, matching this project's existing HUD palette (SECTOR_COLOR_HEX
// in Car.tsx uses the same green/yellow; red matches the trackLimit HUD).
const ZONE_COLOR: Record<ThrottleZone, [number, number, number]> = {
  throttle: [0.22, 1, 0.53], // #39ff88
  lift: [1, 0.82, 0.25], // #ffd23f
  "brake-medium": [1, 0.45, 0.1], // orange
  "brake-hard": [1, 0.23, 0.23], // #ff3b3b
};

function RacingLine({ track }: { track: TrackData }) {
  const geometry = useMemo(() => {
    const line = computeRacingLine(track);
    const { positions, colors, indices } = buildRacingLineRibbon(
      line,
      RACING_LINE_HALF_WIDTH_METERS,
      ZONE_COLOR
    );
    // Lift every vertex above the track surface - positions are flat
    // [x, y, z, ...] triples, so the y component is every 3rd value
    // starting at index 1.
    for (let i = 1; i < positions.length; i += 3) {
      positions[i] += RACING_LINE_HEIGHT_OFFSET;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingBox();
    // TEMP DEBUG - remove before final ship.
    console.log("RACING LINE DEBUG bbox", JSON.stringify(geo.boundingBox), "vertexCount", positions.length / 3);
    return geo;
  }, [track]);

  return (
    <mesh geometry={geometry}>
      {/* TEMP DEBUG color="magenta" swapped in to isolate this mesh visually - remove before final ship. */}
      <meshBasicMaterial vertexColors color="magenta" side={THREE.DoubleSide} />
    </mesh>
  );
}

// TEMP DEBUG: traces the real track edges (from track.width) in cyan, well
// above everything else, to compare against the racing line ribbon's own
// width. Remove before final ship.
function DebugTrackEdges({ track }: { track: TrackData }) {
  const geometry = useMemo(() => {
    const n = track.centerline.length;
    const positions = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = track.centerline[i];
      const p = track.centerline[(i - 1 + n) % n];
      const q = track.centerline[(i + 1) % n];
      const tx = q[0] - p[0];
      const tz = q[2] - p[2];
      const len = Math.hypot(tx, tz) || 1;
      const rightX = -tz / len;
      const rightZ = tx / len;
      const half = track.width[i] / 2;
      const leftIdx = i * 2 * 3;
      const rightIdx = leftIdx + 3;
      positions[leftIdx] = x - rightX * half;
      positions[leftIdx + 1] = y + 0.5;
      positions[leftIdx + 2] = z - rightZ * half;
      positions[rightIdx] = x + rightX * half;
      positions[rightIdx + 1] = y + 0.5;
      positions[rightIdx + 2] = z + rightZ * half;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return geo;
  }, [track]);

  const leftGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const full = geometry.attributes.position.array as Float32Array;
    const left = new Float32Array((full.length / 6) * 3);
    for (let i = 0, j = 0; i < full.length; i += 6, j += 3) {
      left[j] = full[i];
      left[j + 1] = full[i + 1];
      left[j + 2] = full[i + 2];
    }
    g.setAttribute("position", new THREE.BufferAttribute(left, 3));
    return g;
  }, [geometry]);

  const rightGeo = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const full = geometry.attributes.position.array as Float32Array;
    const right = new Float32Array((full.length / 6) * 3);
    for (let i = 3, j = 0; i < full.length; i += 6, j += 3) {
      right[j] = full[i];
      right[j + 1] = full[i + 1];
      right[j + 2] = full[i + 2];
    }
    g.setAttribute("position", new THREE.BufferAttribute(right, 3));
    return g;
  }, [geometry]);

  return (
    <>
      <lineLoop geometry={leftGeo}>
        <lineBasicMaterial color="cyan" />
      </lineLoop>
      <lineLoop geometry={rightGeo}>
        <lineBasicMaterial color="cyan" />
      </lineLoop>
    </>
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
      <DebugTrackEdges track={track} />
    </>
  );
}
