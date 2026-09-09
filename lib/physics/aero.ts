// Simplified aero downforce (plan section 5, depth feature 2): grip scales
// with speed^2, so high-speed corners reward commitment. Deliberately not a
// real drag/lift-coefficient model - a single tuned coefficient scaled to
// be a modest-but-noticeable fraction of this car's own weight at its
// realistic top speed (roughly 30-45% around 40-45 m/s), not full-scale F1
// downforce, which would be far too strong for this car's current tuning.
const DOWNFORCE_COEFFICIENT_N_PER_MS2 = 0.5;

export function computeDownforceN(speedMs: number): number {
  const speed = Math.abs(speedMs);
  return DOWNFORCE_COEFFICIENT_N_PER_MS2 * speed * speed;
}
