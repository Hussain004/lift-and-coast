import type { TrackData } from "./types";

/**
 * A whole-circuit, top-down projection for the landing-page time attack.
 *
 * The race's own minimap (minimap.ts) is CAR-CENTERED and rotates with the
 * car, which is the right choice for a HUD you glance at while driving. A
 * time attack needs the opposite: the whole circuit, fixed and still, with the
 * car visibly travelling around it - so the centerline is projected into a
 * pixel box ONCE and that transform is reused every frame.
 *
 * That "once" is the point. A circuit is 1,700-3,000 centerline points, and
 * re-projecting all of them at 60fps to draw a background that cannot change
 * while the car drives would be pure waste. The caller builds the projection
 * when the circuit changes and re-projects only the CAR - two multiplies - per
 * frame.
 *
 * ORIENTATION, which is the easy thing to get subtly wrong: world X maps to
 * screen X and world Z to screen Y with NO flip. A consequence is that the
 * car's forward vector - (-sin yaw, -cos yaw), the same convention as
 * vehicle.ts, applyCarControls and CAR_WHEELS - is already the screen vector,
 * so at yaw 0 the car points UP the screen. That is what makes the fixed view
 * read as a map. carScreenAngle derives the sprite rotation from the same
 * expression, and tests/minimap.test.ts already pins the forward-vector
 * convention itself at five yaw values.
 *
 * Two circuit shapes are supported, because the landing page needs both and
 * must not download 200KB of centerline JSON to draw a map: the full
 * TrackData once a driving session exists, and the tiny stride-sampled
 * outline sidecar (data/tracks/outlines.json, ~54KB for all thirty circuits)
 * before that. Both are in the same world coordinates, so the map does not
 * jump when it swaps.
 *
 * Pure and DOM-free, so all of it is unit-testable under the node test
 * environment. The caller builds the actual Path2D from the sampled points:
 * canvas is a browser API and nothing here should need it.
 */

export interface TrackProjection {
  /** Pixels per world metre. */
  scale: number;
  /** Screen position of world (0, 0), which is what centres the circuit. */
  originX: number;
  originY: number;
  /** The circuit's axis-aligned world bounds. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Length of the loop in metres (0 for an outline, which does not carry it). */
  lengthMeters: number;
}

/**
 * Fits a set of world [x, z] points into a pixel box, preserving aspect ratio
 * so a long circuit is not stretched, and centring the result.
 *
 * The margin is a fraction of the box's smaller side rather than a pixel
 * count, so the padding looks the same on a phone and on a desktop.
 */
export function createProjection(
  points: readonly [number, number][],
  widthPx: number,
  heightPx: number,
  padFraction = 0.06,
  lengthMeters = 0
): TrackProjection {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < points.length; i++) {
    const [x, z] = points[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
    // An empty point set would make the scale a division by zero. Return a
    // harmless identity rather than NaN coordinates that silently blank the
    // canvas and poison every downstream measurement.
    return {
      scale: 1,
      originX: widthPx / 2,
      originY: heightPx / 2,
      minX: 0,
      maxX: 0,
      minZ: 0,
      maxZ: 0,
      lengthMeters,
    };
  }
  const pad = Math.min(widthPx, heightPx) * Math.max(0, padFraction);
  const spanX = Math.max(1e-9, maxX - minX);
  const spanZ = Math.max(1e-9, maxZ - minZ);
  // ONE scale for both axes. Stretching one would make the circuit's real shape
  // a lie, and a driver judging where on the map they are would be misled.
  const scale = Math.min((widthPx - pad * 2) / spanX, (heightPx - pad * 2) / spanZ);
  return {
    scale,
    // Centre the fitted bounds in the box, which is what leaves the margin
    // equal on every side even though the scale is limited by one axis.
    originX: widthPx / 2 - ((minX + maxX) / 2) * scale,
    originY: heightPx / 2 - ((minZ + maxZ) / 2) * scale,
    minX,
    maxX,
    minZ,
    maxZ,
    lengthMeters,
  };
}

/** The projection for a full circuit, including its real lap length. */
export function createTrackProjection(
  track: TrackData,
  widthPx: number,
  heightPx: number,
  padFraction = 0.06
): TrackProjection {
  return createProjection(
    centerlineToPairs(track),
    widthPx,
    heightPx,
    padFraction,
    track.lengthMeters
  );
}

/** World metres to screen pixels. */
export function projectToCanvas(
  projection: TrackProjection,
  worldX: number,
  worldZ: number
): { x: number; y: number } {
  return {
    x: projection.originX + worldX * projection.scale,
    y: projection.originY + worldZ * projection.scale,
  };
}

/**
 * The screen angle (radians, canvas convention) for a car sprite drawn pointing
 * along +X, given the car's yaw.
 *
 * Forward is (-sin yaw, -cos yaw) in world (x, z), and this projection maps
 * x->X and z->Y with no flip, so that expression is already the screen vector
 * and the rotation is simply its atan2. At yaw 0 the answer is -PI/2: a sprite
 * drawn pointing right is rotated a quarter turn anticlockwise to point up the
 * screen, which is where a car facing -Z belongs.
 */
export function carScreenAngle(yawRad: number): number {
  return Math.atan2(-Math.cos(yawRad), -Math.sin(yawRad));
}

export interface SampledOutline {
  /** Screen points along the circuit, loop order, starting at the line. */
  points: { x: number; y: number }[];
  /** Widest part of the ribbon, in metres. */
  maxWidthMeters: number;
  /**
   * How wide to stroke the road, in pixels: the circuit's own width projected,
   * floored so a narrow street circuit is still visible and capped so a wide
   * one cannot swallow its own corners.
   */
  roadWidthPx: number;
}

/**
 * The circuit decimated to screen points, for building a canvas path.
 *
 * `stride` drops points: 1,700-3,000 vertices stroked every frame is more
 * geometry than the eye resolves at this size, and the saving is real on a
 * phone. The default keeps a few hundred points, well past the point where a
 * circuit still reads as a smooth ribbon. The start point is always included,
 * because it carries the start/finish marker and a path that began anywhere
 * else would put the line in the wrong place.
 */
export function sampleTrackOutline(
  points: readonly [number, number][],
  maxWidthMeters: number,
  projection: TrackProjection,
  stride = 4
): SampledOutline {
  const step = Math.max(1, Math.floor(stride));
  const n = points.length;
  const sampled: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i += step) {
    const [x, z] = points[i];
    sampled.push(projectToCanvas(projection, x, z));
  }
  // Guarantee the start/finish point is present even when the stride skips it,
  // so the line marker always has a point to sit on.
  if (n > 0) {
    const start = projectToCanvas(projection, points[0][0], points[0][1]);
    const first = sampled[0];
    if (first === undefined || Math.hypot(first.x - start.x, first.y - start.y) > 0.5) {
      sampled.unshift(start);
    }
  }
  return {
    points: sampled,
    maxWidthMeters,
    roadWidthPx: Math.min(26, Math.max(3, maxWidthMeters * projection.scale)),
  };
}

/** A TrackData's [x, y, z] centerline as the [x, z] pairs the sampler wants. */
export function centerlineToPairs(track: {
  centerline: readonly [number, number, number][];
}): [number, number][] {
  const pairs: [number, number][] = new Array(track.centerline.length);
  for (let i = 0; i < track.centerline.length; i++) {
    const [x, , z] = track.centerline[i];
    pairs[i] = [x, z];
  }
  return pairs;
}

/** The widest part of a circuit's ribbon, in metres. */
export function widestRibbon(widths: readonly number[]): number {
  let max = 0;
  for (let i = 0; i < widths.length; i++) {
    if (widths[i] > max) max = widths[i];
  }
  return max;
}
