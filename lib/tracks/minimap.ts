import type { TrackData } from "./types";

export const MINIMAP_SIZE_PX = 170;
// Lower = more of the track visible around the car. 0.75 shows roughly a
// 113m radius (half the 170px box / 0.75), up from the original 1.1's ~77m.
export const MINIMAP_ZOOM_PX_PER_METER = 0.75;

/**
 * SVG path `d` in raw world meters (X -> path X, Z -> path Y, no flip) - NOT
 * pre-scaled to pixels. The car-centered minimap applies a live
 * translate+rotate+scale transform (see computeMinimapTransform) to the <g>
 * wrapping this path each frame instead of re-projecting every point every
 * frame, so the path geometry itself only needs computing once.
 */
export function buildMinimapPath(track: TrackData): string {
  return (
    track.centerline
      .map(([x, , z], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${z.toFixed(1)}`)
      .join(" ") + " Z"
  );
}

/**
 * SVG `transform` attribute value for a car-centered, forward-up rotating
 * minimap: centers the view on (carX, carZ) and rotates so the car's own
 * heading (yawRad - same convention as vehicle.ts's yawFromQuaternion and
 * CAR_WHEELS' layout: forward is -Z at yaw 0) always points up on screen,
 * regardless of which way the car is actually facing in world space.
 *
 * Derivation: SVG's rotate(deg) maps a point (x, y) to
 * (x*cos(a) - y*sin(a), x*sin(a) + y*cos(a)) - the standard 2D rotation
 * matrix. Forward at yaw is (-sin(yaw), -cos(yaw)) in (x, z). Solving
 * R(theta) * forward = (0, -1) [straight up on screen] for theta gives
 * theta = yaw exactly, with no sign flip or axis swap - see
 * projectToMinimap and tests/minimap.test.ts for the point-by-point
 * verification of this at several yaw values.
 *
 * SVG applies a transform list right-to-left, so this reads (in order of
 * actual application): center the car at the origin, rotate to align its
 * heading with "up", scale meters to pixels, then move the origin to the
 * box's own center.
 */
export function computeMinimapTransform(
  carX: number,
  carZ: number,
  yawRad: number,
  sizePx: number = MINIMAP_SIZE_PX,
  zoomPxPerMeter: number = MINIMAP_ZOOM_PX_PER_METER
): string {
  const center = sizePx / 2;
  const yawDeg = (yawRad * 180) / Math.PI;
  return (
    `translate(${center},${center}) ` +
    `scale(${zoomPxPerMeter}) ` +
    `rotate(${yawDeg.toFixed(3)}) ` +
    `translate(${(-carX).toFixed(2)},${(-carZ).toFixed(2)})`
  );
}

/**
 * Pure point projection mirroring computeMinimapTransform's own math, so the
 * rotation/centering logic can be unit tested without an SVG parser.
 */
export function projectToMinimap(
  worldX: number,
  worldZ: number,
  carX: number,
  carZ: number,
  yawRad: number,
  sizePx: number = MINIMAP_SIZE_PX,
  zoomPxPerMeter: number = MINIMAP_ZOOM_PX_PER_METER
): { x: number; y: number } {
  const dx = worldX - carX;
  const dz = worldZ - carZ;
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const rx = dx * cos - dz * sin;
  const ry = dx * sin + dz * cos;
  const center = sizePx / 2;
  return { x: center + rx * zoomPxPerMeter, y: center + ry * zoomPxPerMeter };
}
