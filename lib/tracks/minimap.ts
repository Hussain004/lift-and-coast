import type { TrackData } from "./types";

export interface MinimapProjection {
  /** Projects a world (x, z) position to pixel coordinates in the minimap box. */
  toPoint(x: number, z: number): { x: number; y: number };
  /** SVG path `d` attribute tracing the track centerline as a closed loop. */
  pathD: string;
  /** Projected start/finish position. */
  startPoint: { x: number; y: number };
}

/**
 * Uniform-scale (aspect-ratio-preserving) projection of a track's centerline
 * X/Z plane onto a `sizePx` square, padded by `paddingPx` on every side.
 * World Z maps to screen Y directly (no flip) - this only needs to be
 * internally consistent between the static path and the live dot in
 * Car.tsx, not to match any particular on-screen driving direction.
 */
export function buildMinimapProjection(
  track: TrackData,
  sizePx: number,
  paddingPx: number
): MinimapProjection {
  const xs = track.centerline.map(([x]) => x);
  const zs = track.centerline.map(([, , z]) => z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const drawable = sizePx - 2 * paddingPx;
  // Same scale for both axes so the shape isn't stretched - whichever
  // dimension is wider determines the limiting scale.
  const scale = drawable / Math.max(spanX, spanZ, 1e-6);

  function toPoint(x: number, z: number) {
    return {
      x: paddingPx + (x - minX) * scale,
      y: paddingPx + (z - minZ) * scale,
    };
  }

  const pathD = track.centerline
    .map(([x, , z], i) => {
      const p = toPoint(x, z);
      return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    })
    .join(" ") + " Z";

  return { toPoint, pathD, startPoint: toPoint(track.startPos.x, track.startPos.z) };
}
