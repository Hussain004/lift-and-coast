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
const AERO_MODE_MULTIPLIERS: Record<AeroMode, { downforce: number; drag: number }> = {
  "high-downforce": { downforce: 1, drag: 1 },
  "low-drag": { downforce: 0.4, drag: 0.5 },
};

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
