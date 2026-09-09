// Simplified aero model (plan section 5, depth feature 2): grip and drag
// scale with speed^2, so high-speed corners reward commitment and top speed
// is self-limiting. Deliberately not a real drag/lift-coefficient model - a
// single tuned coefficient scaled to be a modest-but-noticeable fraction of
// this car's own weight at its realistic top speed (roughly 30-45% around
// 40-45 m/s), not full-scale F1 downforce, which would be far too strong for
// this car's current tuning.
const DOWNFORCE_COEFFICIENT_N_PER_MS2 = 0.5;

// Tuned so drag stays a minor share of engine force in the speed range the
// existing stability suite already covers (~65N at 14.7 m/s vs 500N boosted
// engine force, under 15%) - it should cap top speed, not fight low-speed
// acceleration the way LINEAR_DAMPING already does.
const DRAG_COEFFICIENT_N_PER_MS2 = 0.3;

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
