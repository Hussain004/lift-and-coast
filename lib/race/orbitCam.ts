// Plan section 9 (free replay cam): orbit math for the post-race free view
// - circle a fixed anchor with drag-rotate and wheel-zoom while the game
// runs underneath. Pure functions (angles in, position out) so the
// clamping is unit-testable; Scene.tsx only stores the angles and applies
// them, with no filters or follow logic that could drift.
export interface OrbitState {
  ax: number;
  ay: number;
  az: number;
  yaw: number;
  pitch: number;
  radius: number;
}

export const ORBIT_MIN_PITCH = -0.15;
export const ORBIT_MAX_PITCH = 1.25;
export const ORBIT_MIN_RADIUS = 4;
export const ORBIT_MAX_RADIUS = 120;

/** Anchor an orbit on a world point, framed from behind-above. The offset
 * (sin yaw, cos yaw) is exactly minus the heading forward (-sin, -cos),
 * i.e. behind the car (see lib/tracks/minimap.ts for the convention). */
export function anchorOrbit(
  x: number,
  y: number,
  z: number,
  carYawRad: number
): OrbitState {
  return { ax: x, ay: y + 0.8, az: z, yaw: carYawRad, pitch: 0.32, radius: 11 };
}

export function clampOrbit(state: OrbitState): OrbitState {
  return {
    ...state,
    pitch: Math.min(ORBIT_MAX_PITCH, Math.max(ORBIT_MIN_PITCH, state.pitch)),
    radius: Math.min(ORBIT_MAX_RADIUS, Math.max(ORBIT_MIN_RADIUS, state.radius)),
  };
}

/** Camera world position for an orbit state. */
export function orbitPosition(state: OrbitState): { x: number; y: number; z: number } {
  const o = clampOrbit(state);
  const flat = o.radius * Math.cos(o.pitch);
  return {
    x: o.ax + flat * Math.sin(o.yaw),
    y: o.ay + o.radius * Math.sin(o.pitch),
    z: o.az + flat * Math.cos(o.yaw),
  };
}
