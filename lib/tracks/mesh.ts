import type { TrackData } from "./types";

// The track and the grass runoff around it are separate colliders that meet
// along the ribbon's edge. The grass should sit this far below the ribbon,
// not flush (a raycast wheel can ping-pong between two colliders at the exact
// same height) and not much more (a bigger gap becomes a literal curb a
// wheel has to climb crossing from grass back onto the track - the original
// 5cm gap did exactly that, producing a sharp pitch spike reported as the
// car "twitching" every so often during normal driving, whenever a corner
// was taken wide enough to touch grass and come back). Both Scene.tsx and
// the headless harness derive their ground collider's height from this; since
// the ribbon gained real elevation it is applied to the runoff's own
// elevation-following surface (see lib/tracks/terrain.ts) rather than to a
// global plane height.
export const GRASS_BELOW_TRACK_METERS = 0.01;

export interface RibbonGeometry {
  /** [x, y, z, x, y, z, ...] vertex positions. */
  positions: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
}

/**
 * Builds a ribbon mesh along a closed centerline, offsetting each point
 * left/right by half its width. Each cross-section is horizontal (the
 * centerline's own y at that point) - the surface follows the lap's
 * elevation but has no camber or banking, which is what the track data
 * currently describes. That means the ribbon does carry a real slope along
 * the track, so callers must compute vertex normals from the geometry (see
 * Track.tsx) rather than assume a flat, up-facing surface.
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
