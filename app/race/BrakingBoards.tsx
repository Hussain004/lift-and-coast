"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { getRacingLine } from "@/lib/tracks/racingLineCache";
import {
  BOARD_CELLS,
  BOARD_DISTANCES_METERS,
  buildBoardMesh,
  computeBrakingBoards,
} from "@/lib/tracks/brakingBoards";
import type { TrackData } from "@/lib/tracks/types";

const CELL_W = 128;
const CELL_H = 96;

/** The atlas: white faces with a red frame and the distance, then a dark post cell. */
function boardAtlas(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = CELL_W * BOARD_CELLS;
  c.height = CELL_H;
  const g = c.getContext("2d");
  if (!g) return null;
  BOARD_DISTANCES_METERS.forEach((meters, i) => {
    const x = i * CELL_W;
    g.fillStyle = "#f4f4f0";
    g.fillRect(x, 0, CELL_W, CELL_H);
    g.fillStyle = "#d81f26";
    g.fillRect(x, 0, CELL_W, 10);
    g.fillRect(x, CELL_H - 10, CELL_W, 10);
    g.font = "900 60px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillStyle = "#121216";
    g.fillText(String(meters), x + CELL_W / 2, CELL_H / 2 + 2);
  });
  g.fillStyle = "#2a2c33";
  g.fillRect(BOARD_DISTANCES_METERS.length * CELL_W, 0, CELL_W, CELL_H);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The 300/200/100/50 boards before each big braking zone (see
 * lib/tracks/brakingBoards.ts): one merged mesh, one draw call, visual only.
 */
export function BrakingBoards({ track }: { track: TrackData }) {
  const { geometry, map } = useMemo(() => {
    const mesh = buildBoardMesh(computeBrakingBoards(track, getRacingLine(track)));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(mesh.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeBoundingSphere();
    return { geometry: g, map: boardAtlas() };
  }, [track]);
  return (
    <mesh geometry={geometry}>
      <meshBasicMaterial map={map} side={THREE.DoubleSide} />
    </mesh>
  );
}
