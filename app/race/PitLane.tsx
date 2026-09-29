"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { getPitLane } from "@/lib/tracks/pitLane";
import { buildPitLaneMeshes, type PitMesh } from "@/lib/tracks/pitLaneMesh";
import type { TrackData } from "@/lib/tracks/types";
import { SurfaceMaterial } from "./renderQuality";

function toGeometry(mesh: PitMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
  g.setAttribute("color", new THREE.BufferAttribute(mesh.colors, 3));
  g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * The drivable pit lane (lib/tracks/pitLane.ts): asphalt, lines, pit wall,
 * garages and the player's box. Four draw calls, visual only. Renders
 * nothing on circuits with no room for a lane.
 */
export function PitLane({ track }: { track: TrackData }) {
  const geometries = useMemo(() => {
    const lane = getPitLane(track);
    if (!lane) return null;
    const meshes = buildPitLaneMeshes(track, lane);
    return {
      asphalt: toGeometry(meshes.asphalt),
      paint: toGeometry(meshes.paint),
      walls: toGeometry(meshes.walls),
      garages: toGeometry(meshes.garages),
    };
  }, [track]);
  if (!geometries) return null;
  return (
    <>
      <mesh geometry={geometries.asphalt} receiveShadow>
        <SurfaceMaterial vertexColors />
      </mesh>
      <mesh geometry={geometries.paint}>
        <meshBasicMaterial vertexColors polygonOffset polygonOffsetFactor={-2} polygonOffsetUnits={-2} />
      </mesh>
      <mesh geometry={geometries.walls}>
        <SurfaceMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geometries.garages}>
        <SurfaceMaterial vertexColors side={THREE.DoubleSide} />
      </mesh>
    </>
  );
}
