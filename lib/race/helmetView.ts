// Helmet-camera framing geometry.
//
// The helmet view is the one camera that has to satisfy two opposing
// requirements at once:
//
//   1. The eye must sit INSIDE the sculpted driver helmet (a closed sphere at
//      (0, 0.42, 0.3) with radius 0.16 - see lib/race/carSculpt.ts), or the
//      helmet shell itself fills the frame.
//   2. The steering wheel must land in the lower third of the frame, not
//      below the bottom edge and not in the middle of the road ahead.
//
// Both are pure geometry, so they live here rather than as magic numbers
// split across Scene.tsx (the camera) and CarBodyMesh.tsx (the wheel), and
// tests/helmetView.test.ts locks the relationship down.

/** Driver eye point in the car frame (+x right, +y up, -z forward). */
export const HELMET_EYE_Y = 0.52;
export const HELMET_EYE_Z = 0.36;

/** Wide interior FOV, as a real on-board/helmet feed uses. */
export const HELMET_FOV_DEG = 90;

/** Aim point: this far ahead, dropped by this much (a touch of down-tilt so
 *  the wheel rim stays clear of the bottom edge without tipping the
 *  horizon). */
export const HELMET_AIM_DISTANCE_METERS = 20;
export const HELMET_AIM_DROP_METERS = 0.45;

/** Steering wheel centre and half-extents in the car frame. */
export const STEERING_WHEEL_CENTER_Y = 0.27;
export const STEERING_WHEEL_CENTER_Z = -0.08;
export const STEERING_WHEEL_HALF_WIDTH = 0.2;
export const STEERING_WHEEL_HALF_HEIGHT = 0.125;

function deg(radians: number): number {
  return (radians * 180) / Math.PI;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Downward pitch of the camera axis, in degrees (positive = looking down). */
export function helmetAimPitchDeg(): number {
  return deg(Math.atan2(HELMET_AIM_DROP_METERS, HELMET_AIM_DISTANCE_METERS));
}

/** Vertical half-FOV in degrees. */
export function helmetVerticalHalfFovDeg(): number {
  return HELMET_FOV_DEG / 2;
}

/** Horizontal half-FOV in degrees for a given viewport aspect. */
export function helmetHorizontalHalfFovDeg(aspect: number): number {
  const safeAspect = Math.max(0.1, aspect);
  return deg(Math.atan(Math.tan((HELMET_FOV_DEG * Math.PI) / 360) * safeAspect));
}

export interface HelmetFraming {
  /** Wheel centre below the camera axis, degrees (0.23 rad-scale value). */
  wheelCenterBelowAxisDeg: number;
  /** Topmost wheel point below the axis, degrees. */
  wheelTopBelowAxisDeg: number;
  /** Bottom-most wheel point below the axis, degrees - the binding edge. */
  wheelBottomBelowAxisDeg: number;
  /** Half the wheel's angular width, degrees. */
  wheelHalfWidthDeg: number;
  verticalHalfFovDeg: number;
  horizontalHalfFovDeg: number;
  /** True when the whole wheel is inside the frame on the reference aspect. */
  wheelFullyVisible: boolean;
}

/**
 * Where the wheel falls inside the helmet frame. `aspect` is the viewport's
 * width/height (16:9 desktop, ~2.1 for a wide landscape phone, ~0.6 in a
 * narrow portrait stage).
 */
export function helmetWheelFraming(aspect = 16 / 9): HelmetFraming {
  // Car frame: the eye looks down -z, so the wheel sits at +z relative to it.
  const dz = HELMET_EYE_Z - STEERING_WHEEL_CENTER_Z;
  const dy = STEERING_WHEEL_CENTER_Y - HELMET_EYE_Y;
  const pitch = helmetAimPitchDeg();
  const verticalHalfFov = helmetVerticalHalfFovDeg();
  const horizontalHalfFov = helmetHorizontalHalfFovDeg(aspect);

  const centerBelow = deg(Math.atan2(-dy, dz)) - pitch;
  const topBelow = deg(Math.atan2(-(dy + STEERING_WHEEL_HALF_HEIGHT), dz)) - pitch;
  const bottomBelow = deg(Math.atan2(-(dy - STEERING_WHEEL_HALF_HEIGHT), dz)) - pitch;
  const halfWidth = deg(Math.atan2(STEERING_WHEEL_HALF_WIDTH, dz));

  return {
    wheelCenterBelowAxisDeg: centerBelow,
    wheelTopBelowAxisDeg: topBelow,
    wheelBottomBelowAxisDeg: bottomBelow,
    wheelHalfWidthDeg: halfWidth,
    verticalHalfFovDeg: verticalHalfFov,
    horizontalHalfFovDeg: horizontalHalfFov,
    wheelFullyVisible:
      bottomBelow < verticalHalfFov &&
      topBelow > -verticalHalfFov &&
      halfWidth < horizontalHalfFov &&
      centerBelow > -verticalHalfFov,
  };
}

/** Mirrors and the nose must also stay off the exact frame centre: the widest
 *  useful sanity check is that the mirror housings at +/-0.6m are still in
 *  shot on a normal landscape viewport. */
export function helmetSideTrimInFrame(aspect = 16 / 9): boolean {
  const dz = HELMET_EYE_Z - STEERING_WHEEL_CENTER_Z;
  const angle = deg(Math.atan2(0.6, dz));
  return angle < helmetHorizontalHalfFovDeg(aspect);
}

/** Clamp helper reused by callers that want a safe 0..1 wheel size. */
export function helmetWheelScreenFraction(): number {
  const dz = HELMET_EYE_Z - STEERING_WHEEL_CENTER_Z;
  return clamp(STEERING_WHEEL_HALF_HEIGHT / dz, 0, 1);
}
