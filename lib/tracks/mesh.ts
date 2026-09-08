import type { TrackData } from "./types";

export interface RibbonGeometry {
  /** Flat [x, y, z, x, y, z, ...] vertex positions. */
  positions: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
}

/**
 * Builds a flat ribbon mesh along a closed centerline, offsetting each
 * point left/right by half its width. The track is currently flat
 * (centerline y is always 0), so this skips per-vertex normal computation
 * from geometry - revisit once elevation/camber keyframes exist.
 */
export function buildRibbonGeometry(track: TrackData): RibbonGeometry {
  const n = track.centerline.length;
  const positions = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const [x, y, z] = track.centerline[i];
    const [px, , pz] = track.centerline[(i - 1 + n) % n];
    const [nx, , nz] = track.centerline[(i + 1) % n];

    const tangentX = nx - px;
    const tangentZ = nz - pz;
    const tangentLen = Math.hypot(tangentX, tangentZ) || 1;
    const rightX = -tangentZ / tangentLen;
    const rightZ = tangentX / tangentLen;

    const halfWidth = track.width[i] / 2;
    const leftIdx = i * 2 * 3;
    const rightIdx = leftIdx + 3;

    positions[leftIdx] = x - rightX * halfWidth;
    positions[leftIdx + 1] = y;
    positions[leftIdx + 2] = z - rightZ * halfWidth;

    positions[rightIdx] = x + rightX * halfWidth;
    positions[rightIdx + 1] = y;
    positions[rightIdx + 2] = z + rightZ * halfWidth;
  }

  const indices = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const l0 = i * 2;
    const r0 = l0 + 1;
    const l1 = ((i + 1) % n) * 2;
    const r1 = l1 + 1;
    const o = i * 6;
    indices[o] = l0;
    indices[o + 1] = r0;
    indices[o + 2] = l1;
    indices[o + 3] = r0;
    indices[o + 4] = r1;
    indices[o + 5] = l1;
  }

  return { positions, indices };
}
