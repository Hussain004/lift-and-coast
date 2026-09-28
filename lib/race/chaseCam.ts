// Chase-camera feel, as pure maths (Scene.tsx's ChaseCamera applies it).
//
// The hard rule this file exists to keep: NO speed-proportional lag. A lag
// filter on camera position (or on the look-at point) settles speed x tau
// behind the car - it made the car shrink with speed and the view pan down
// at 300 km/h (the "galloping" bug, see the long comments in Scene.tsx).
// Everything here is either angular or instantaneous:
//
// - stepCameraYaw lags the camera's HEADING, not its position. The camera
//   still sits exactly CHASE_OFFSET from the car - just swung by a few
//   degrees while the car rotates. The error is bounded by yaw rate x tau
//   and clamped, and on a straight it is exactly zero at any speed.
// - fovForSpeed is a pure function of the current speed: nothing to drift.
// - shakeOffset is deterministic noise with a hard amplitude ceiling.

/** Wraps an angle difference into (-pi, pi]. */
export function wrapAngle(a: number): number {
  let x = a % (Math.PI * 2);
  if (x > Math.PI) x -= Math.PI * 2;
  if (x <= -Math.PI) x += Math.PI * 2;
  return x;
}

/** How quickly the camera heading catches the car's, per second. */
export const CAMERA_YAW_RATE = 7;
/** The camera never trails the car's heading by more than this. */
export const CAMERA_MAX_YAW_LAG_RAD = (12 * Math.PI) / 180;

/**
 * The chase camera's heading one frame on: the car's heading minus a lag
 * that decays exponentially (frame-rate independent) and is clamped. A
 * reset (mode switch, teleport) is just passing the car's yaw as camYaw.
 */
export function stepCameraYaw(
  camYaw: number,
  carYaw: number,
  dt: number,
  rate = CAMERA_YAW_RATE,
  maxLag = CAMERA_MAX_YAW_LAG_RAD
): number {
  const lag = wrapAngle(carYaw - camYaw) * Math.exp(-rate * Math.max(0, dt));
  const clamped = Math.max(-maxLag, Math.min(maxLag, lag));
  return carYaw - clamped;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Speed sensation: the field of view widens by up to `kickDeg` from 150 to 330 km/h. */
export function fovForSpeed(baseDeg: number, speedMs: number, kickDeg = 8): number {
  return baseDeg + kickDeg * smoothstep(150 / 3.6, 330 / 3.6, Math.abs(speedMs));
}

/**
 * Camera shake in metres: kerb rumble plus a faint high-speed buzz, from
 * summed sines (deterministic, no allocation). Never exceeds `maxMeters`.
 */
export function shakeOffset(
  timeSeconds: number,
  kerb01: number,
  speedMs: number,
  maxMeters = 0.025
): { x: number; y: number } {
  const speed01 = smoothstep(120 / 3.6, 320 / 3.6, Math.abs(speedMs));
  const amp = Math.min(maxMeters, maxMeters * (0.8 * Math.max(0, Math.min(1, kerb01)) + 0.2 * speed01));
  const t = timeSeconds;
  const nx = (Math.sin(t * 61.3) + Math.sin(t * 37.9 + 1.7) * 0.6) / 1.6;
  const ny = (Math.sin(t * 53.1 + 0.4) + Math.sin(t * 29.3 + 2.9) * 0.6) / 1.6;
  return { x: nx * amp, y: ny * amp };
}
