// Simplified aero model (plan section 5, depth feature 2): grip and drag
// scale with speed^2, so high-speed corners reward commitment and top speed
// is self-limiting. Deliberately not a real drag/lift-coefficient model - a
// single tuned coefficient scaled to be a modest-but-noticeable fraction of
// this car's own weight at its realistic top speed (roughly 30-45% around
// 40-45 m/s), not full-scale F1 downforce, which would be far too strong for
// this car's current tuning.
const DOWNFORCE_COEFFICIENT_N_PER_MS2 = 0.5;

// Tuned so drag stays a minor share of engine force through the launch and
// acceleration range, but still gives deployment a meaningful straight-line
// window. The old 0.30 coefficient put the high-downforce car's drag-limited
// top speed almost underneath the old 62 m/s final-gear ceiling, so deploying
// on a long straight spent battery without changing the speed the car could
// actually hold. 0.24 leaves a visible gap between normal and deployed pace
// while keeping the same broad aero model (and the stability suite's braking
// margin) intact.
const DRAG_COEFFICIENT_N_PER_MS2 = 0.24;

export type AeroMode = "high-downforce" | "low-drag";

// High-downforce is the identity case (multipliers of 1) so every existing
// scenario and test, tuned before aero modes existed, keeps behaving exactly
// as before. Low-drag trades grip for a higher top speed.
//
// grip is a direct mechanical-grip penalty for low-drag mode ("flattened
// wings"), separate from the downforce->load->grip coupling in
// applyLoadSensitiveFriction. That coupling alone doesn't punish cornering
// in low-drag mode: at typical cornering speeds (~10 m/s) downforce is under
// 1.5% of the car's static weight in either mode, so the load-sensitivity
// curve barely moves - confirmed empirically (off-track distance at
// steer=0.3 differed by ~1.4% between modes with grip unset). This field is
// what actually makes low-drag mode bleed grip through corners.
//
// 0.5 rather than something milder like 0.8: Rapier's raycast vehicle
// constrains lateral velocity rather than modeling a real force-based slip
// limit, so moderate steering inputs stay within grip in either mode
// regardless of a small penalty - only a strong one produces a felt
// difference. Verified at hard steer (0.9) after building speed: 0.5 grip
// gives ~11% less net turn-in and ~21% more off-track distance than
// high-downforce, at tilt still far under the flip threshold.
const AERO_MODE_MULTIPLIERS: Record<AeroMode, { downforce: number; drag: number; grip: number }> = {
  "high-downforce": { downforce: 1, drag: 1, grip: 1 },
  "low-drag": { downforce: 0.4, drag: 0.5, grip: 0.5 },
};

export function aeroGripMultiplier(mode: AeroMode): number {
  return AERO_MODE_MULTIPLIERS[mode].grip;
}

export function computeDownforceN(
  speedMs: number,
  mode: AeroMode = "high-downforce"
): number {
  const speed = Math.abs(speedMs);
  return DOWNFORCE_COEFFICIENT_N_PER_MS2 * AERO_MODE_MULTIPLIERS[mode].downforce * speed * speed;
}

export function computeDragN(
  speedMs: number,
  mode: AeroMode = "high-downforce"
): number {
  const speed = Math.abs(speedMs);
  return DRAG_COEFFICIENT_N_PER_MS2 * AERO_MODE_MULTIPLIERS[mode].drag * speed * speed;
}

/** Most of a car's aero drag it can lose tucked in behind another: 14%
 * is worth ~7% of top speed nose-to-tail - a real straight-line tow,
 * enough to close and pull out, not a slingshot. */
export const MAX_TOW_DRAG_REDUCTION = 0.14;
const TOW_MIN_SPEED_MS = 25;
const TOW_NEAR_METERS = 3.5;
const TOW_FAR_METERS = 40;

/**
 * Slipstream: the aero-drag multiplier (1 = clean air) for a car at (x, z)
 * heading `yawRad`, given the other cars' positions. The wake is strongest
 * right behind a car and fades out by 40m, in a narrow cone around the car
 * ahead, so pulling out to pass leaves it. Pure geometry, shared by the
 * player, the AI and the headless field. Yaw convention: forward is
 * (-sin yaw, -cos yaw).
 */
export function towDragScale(
  own: { x: number; z: number; yawRad: number; speedMs: number },
  others: readonly { x: number; z: number }[]
): number {
  if (Math.abs(own.speedMs) < TOW_MIN_SPEED_MS) return 1;
  const fx = -Math.sin(own.yawRad);
  const fz = -Math.cos(own.yawRad);
  let best = 0;
  for (const o of others) {
    const dx = o.x - own.x;
    const dz = o.z - own.z;
    const ahead = dx * fx + dz * fz;
    if (ahead < TOW_NEAR_METERS || ahead > TOW_FAR_METERS) continue;
    const lateral = Math.abs(dx * -fz + dz * fx);
    const halfWidth = 1.3 + ahead * 0.02;
    if (lateral > halfWidth) continue;
    const strength =
      (1 - (ahead - TOW_NEAR_METERS) / (TOW_FAR_METERS - TOW_NEAR_METERS)) * (1 - 0.5 * (lateral / halfWidth));
    if (strength > best) best = strength;
  }
  return 1 - MAX_TOW_DRAG_REDUCTION * best;
}
