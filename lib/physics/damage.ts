// Plan section 5, "Collisions & damage": "impacts above a threshold reduce
// front/rear aero efficiency or induce wheel misalignment (pulls the car).
// Consequential contact without a deformation system." There are no walls
// or opponent cars to hit yet (plan section 6), so today this only
// triggers from a hard chassis-to-ground impact (e.g. landing a bad flip)
// - still a genuine "impact above a threshold", just a narrower set of
// real-world triggers than the eventual multi-car version will have.
const DAMAGE_FORCE_THRESHOLD_N = 15000;
const DAMAGE_PER_HIT_FRACTION = 0.15;
export const MIN_DAMAGE_GRIP_FRACTION = 0.6;

/**
 * Applies one hit's worth of damage to an existing grip multiplier
 * (1 = undamaged), given that contact's total force. Below-threshold
 * contacts (normal suspension loads, gentle kerb contact) don't damage the
 * car at all. Only ever multiplies below 1x on top of whatever multiplier
 * it's given, same composition pattern as every other grip scale in
 * vehicle.ts/tireModel.ts/trackLimits.ts, so it composes safely with them.
 */
export function applyImpactDamage(currentGripMultiplier: number, impactForceN: number): number {
  if (impactForceN < DAMAGE_FORCE_THRESHOLD_N) return currentGripMultiplier;
  return Math.max(MIN_DAMAGE_GRIP_FRACTION, currentGripMultiplier - DAMAGE_PER_HIT_FRACTION);
}
