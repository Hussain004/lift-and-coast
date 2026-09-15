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
    return geo;
  }, [track]);

  return (
    <mesh geometry={geometry}>
      {/* vertexColors, not a single material color - each vertex carries
          its own throttle/brake zone color (see ZONE_COLOR). basic (not
          standard) so scene lighting doesn't tint or darken the colors -
          this is a flat HUD-style overlay, not a lit surface. */}
      <meshBasicMaterial vertexColors />
    </mesh>
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
