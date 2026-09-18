import type { TrackData } from "./types";
import { KERB_WIDTH_METERS, kerbHeightMeters, surfaceZones } from "./surfaces";

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

// Rendered colors of the ground surfaces, centralized so their contrast
// is pinned in one place and regression-tested (see tests/mesh.test.ts).
// The ribbon used to sit on near-black gray grass (#202020) at a 1.66:1
// luminance ratio; the grass is now a real (dark) green, so separation is
// hue as well as luminance - gray asphalt reads against green runoff the
// way real circuits do. Gravel traps (see terrain.ts) get their own tan.
export const RIBBON_COLOR = "#525252";
export const GRASS_COLOR = "#2E4A24";
/** Sun-baked gravel trap tan (see terrain vertex colors in terrain.ts). */
export const GRAVEL_COLOR = "#9A8B60";

/**
 * sRGB hex to linear working-space triple, for vertex colors fed straight
 * to the GPU (which skips the automatic conversion a material `color` gets
 * - writing raw sRGB values would render roughly twice as bright as the
 * same hex on a material).
 */
export function hexToLinearRgb(hex: string): [number, number, number] {
  const channel = (at: number): number => {
    const s = parseInt(hex.slice(at, at + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

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

export interface KerbGeometry extends RibbonGeometry {
  /** [r, g, b, ...] in 0-1, one per position triple (see KERB_STRIPE_COLORS). */
  colors: Float32Array;
}

// Arc length of one kerb stripe, in meters - one quad of the built geometry.
// Real painted kerbs alternate every ~1m, but this project's centerline is
// resampled at exactly 2m, so 2m is the finest stripe the geometry can draw
// with a hard edge (each quad one solid colour, alternating). At 1.5m the
// stripes would alias into a gradient.
export const KERB_STRIPE_METERS = 2;
// Two-colour alternating stripes. Deliberately the classic red/white instead
// of this project's HUD palette: a kerb is scenery, not UI, and the read
// ("that's a kerb") is the whole point.
const KERB_STRIPE_COLORS: [number, number, number][] = [
  [0.82, 0.16, 0.16],
  [0.9, 0.9, 0.9],
];

/**
 * Builds the visible kerb strips for the zones surfaceZones derives (plan
 * section 4 point 6). Visual only: the physics of riding a kerb is a
 * per-wheel suspension ride height, not collider geometry, for the same
 * overlapping-collider reason GRASS_BELOW_TRACK_METERS documents above - so
 * this mesh is added to the scene and never handed to Rapier.
 *
 * Each quad is its own four vertices rather than a shared strip, so a stripe
 * edge is a hard colour change instead of a two-metre gradient, and so a run
 * of kerbs can be emitted without any run bookkeeping: a quad is emitted
 * wherever two consecutive points carry the same kerb type on the same side.
 * A type change (low -> aggressive) therefore leaves a one-quad gap, which
 * also reads as the real joint between two kerb sections.
 *
 * The strip runs from the ribbon edge (at the ribbon's own y) up to the kerb
 * height at its outer edge, i.e. a ramp matching the ramp the physics applies
 * over the first fraction of a metre - so there is no vertical face at the
 * ribbon edge, which a driver would otherwise see as a wall the car ignores.
 */
export function buildKerbGeometry(track: TrackData): KerbGeometry {
  const zones = surfaceZones(track);
  const n = track.centerline.length;

  // Cumulative arc length, for the stripe phase.
  const arc = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const a = track.centerline[i];
    const b = track.centerline[(i + 1) % n];
    arc[i + 1] = arc[i] + Math.hypot(b[0] - a[0], b[2] - a[2]);
  }

  // Right unit vector per point (same convention as buildRibbonGeometry).
  const rightX = new Float64Array(n);
  const rightZ = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const before = track.centerline[(i - 1 + n) % n];
    const after = track.centerline[(i + 1) % n];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const len = Math.hypot(tx, tz) || 1;
    rightX[i] = -tz / len;
    rightZ[i] = tx / len;
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const push = (
    x: number,
    y: number,
    z: number,
    color: [number, number, number]
  ): number => {
    positions.push(x, y, z);
    colors.push(color[0], color[1], color[2]);
    return positions.length / 3 - 1;
  };

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = track.centerline[i];
    const q = track.centerline[j];
    for (const side of ["left", "right"] as const) {
      const type = zones[i][side];
      // No quad where either end has no kerb, or where the type changes.
      if (!type || zones[j][side] !== type) continue;
      const sign = side === "right" ? 1 : -1;
      const height = kerbHeightMeters(type);
      const stripe =
        KERB_STRIPE_COLORS[Math.floor(arc[i] / KERB_STRIPE_METERS) % KERB_STRIPE_COLORS.length];
      const innerI = track.width[i] / 2;
      const outerI = innerI + KERB_WIDTH_METERS;
      const innerJ = track.width[j] / 2;
      const outerJ = innerJ + KERB_WIDTH_METERS;
      const a = push(p[0] + sign * rightX[i] * innerI, p[1], p[2] + sign * rightZ[i] * innerI, stripe);
      const b = push(p[0] + sign * rightX[i] * outerI, p[1] + height, p[2] + sign * rightZ[i] * outerI, stripe);
      const c = push(q[0] + sign * rightX[j] * innerJ, q[1], q[2] + sign * rightZ[j] * innerJ, stripe);
      const d = push(q[0] + sign * rightX[j] * outerJ, q[1] + height, q[2] + sign * rightZ[j] * outerJ, stripe);
      // Wind each triangle from its measured facing. Mirroring the quad
      // across the centerline flips its facing, so the left run needs the
      // opposite order from the right run - and at very tight inside
      // corners (Monaco's hairpin/Rascasse) consecutive edge points nearly
      // coincide and a quad can fold, which no fixed order survives. Same
      // vertices either way, so striping, counts and runs are untouched;
      // only the front face is guaranteed up.
      const normalY = (i0: number, i1: number, i2: number): number => {
        const ax = positions[i0 * 3];
        const az = positions[i0 * 3 + 2];
        const bx = positions[i1 * 3];
        const bz = positions[i1 * 3 + 2];
        const cx = positions[i2 * 3];
        const cz = positions[i2 * 3 + 2];
        return (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      };
      if (normalY(a, b, c) > 0) indices.push(a, b, c);
      else indices.push(a, c, b);
      if (normalY(b, d, c) > 0) indices.push(b, d, c);
      else indices.push(b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
  };
}

// Painted white edge lines, one continuous strip per side for the whole lap
// (every real circuit outlines its asphalt this way). Visual only, like the
// kerbs: never handed to Rapier. Four vertices per centerline point (outer
// and inner edge of each side's strip), quads between consecutive points,
// using the same index pattern as buildRibbonGeometry with the side's two
// vertices in (left, right) order so every triangle faces up - the strips
// sit strictly inside their ribbon quad, so they inherit its facing. Flat
// at the ribbon's own y; the caller lifts the mesh (see Track.tsx) so it
// neither z-fights the asphalt nor loses to the racing-line overlay where
// that sweeps across an edge.
export const EDGE_LINE_WIDTH_METERS = 0.3;

export function buildEdgeLineGeometry(track: TrackData): RibbonGeometry {
  const n = track.centerline.length;
  const positions = new Float32Array(n * 4 * 3);

  for (let i = 0; i < n; i++) {
    const [x, y, z] = track.centerline[i];
    const [px, , pz] = track.centerline[(i - 1 + n) % n];
    const [nx, , nz] = track.centerline[(i + 1) % n];
    const tangentX = nx - px;
    const tangentZ = nz - pz;
    const tangentLen = Math.hypot(tangentX, tangentZ) || 1;
    const rightX = -tangentZ / tangentLen;
    const rightZ = tangentX / tangentLen;

    const outer = track.width[i] / 2;
    const inner = outer - EDGE_LINE_WIDTH_METERS;
    const base = i * 4 * 3;
    // Left strip: outer then inner (outer is the "left", matching the
    // ribbon's own left/right order and therefore its facing).
    positions[base] = x - rightX * outer;
    positions[base + 1] = y;
    positions[base + 2] = z - rightZ * outer;
    positions[base + 3] = x - rightX * inner;
    positions[base + 4] = y;
    positions[base + 5] = z - rightZ * inner;
    // Right strip: inner then outer, so (first, second) again runs
    // left-to-right and keeps the ribbon's facing.
    positions[base + 6] = x + rightX * inner;
    positions[base + 7] = y;
    positions[base + 8] = z + rightZ * inner;
    positions[base + 9] = x + rightX * outer;
    positions[base + 10] = y;
    positions[base + 11] = z + rightZ * outer;
  }

  const indices = new Uint32Array(n * 2 * 6);
  for (let i = 0; i < n; i++) {
    const a = i * 4;
    const b = ((i + 1) % n) * 4;
    const o = i * 12;
    // Left strip quad (verts 0,1 here and at the next point).
    indices[o] = a;
    indices[o + 1] = a + 1;
    indices[o + 2] = b;
    indices[o + 3] = a + 1;
    indices[o + 4] = b + 1;
    indices[o + 5] = b;
    // Right strip quad (verts 2,3 here and at the next point).
    indices[o + 6] = a + 2;
    indices[o + 7] = a + 3;
    indices[o + 8] = b + 2;
    indices[o + 9] = a + 3;
    indices[o + 10] = b + 3;
    indices[o + 11] = b + 2;
  }

  return { positions, indices };
}
