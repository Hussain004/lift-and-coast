/**
 * Fuel as real body mass (IMPROVEMENTS.md finding F6, phase A8).
 *
 * The strategy system used to pace the field through a flat "a full tank
 * costs 3.5 %" shim without the physics ever feeling the fuel. This module
 * turns fuel into kilograms the body actually carries, so acceleration,
 * braking distances, kerb ride heights over bumps and the load-sensitive
 * tyre model all degrade honestly as the stint runs down - the car genuinely
 * changes underneath you across a race, which is most of what "fuel is
 * strategic" means in the real thing.
 *
 * The scale factor is the interesting decision. In a real F1 car a 100 kg
 * tank is ~15 % of the fuel-free core mass (and that is the fraction that
 * makes fuel-tire-and-drag maths work out to ~0.3 s per 10 kg). This game's
 * chassis is arcade-scaled at 220 kg, so the honest translation is
 * 0.15 x 220 = 33 kg at a full 100 kg tank, i.e. 0.33 kg of added mass per
 * kilogram of fuel. Emulating "100 kg of real fuel" as 100 kg of sim mass
 * would be catastrophic at this scale (45 % heavier car, tidal braking,
 * ruined flip budget) and emulating 1.0 kg/kg of the *ratio* would be
 * physically correct only at the real mass, not the arcade one.
 *
 * Player-only by design: callers that opt in (the live player car's
 * Car.tsx, and nothing else) also tell their strategy system
 * `fuelMassModel: true` so the 3.5 % pace shim does not double-count the
 * mass. Every AI caller keeps the shim exactly as validated.
 */

/** Added body mass (kg) per kilogram of fuel carried. */
export const FUEL_MASS_SIMULATION_KG_PER_KG = 0.33;

/**
 * Quantization of the live mass update so a heaving body-prop is not
 * produced every frame: the caller only calls setAdditionalMass when the
 * desired mass has moved this far from the last applied value. Chosen well
 * below the per-lap fuel burn (~2 kg), so the car still sheds mass
 * continuously across a stint.
 */
export const FUEL_MASS_UPDATE_THRESHOLD_KG = 0.25;

/**
 * Desired addition to the chassis mass for a given remaining fuel weight.
 * Returns 0 for any non-finite or negative input rather than ever letting a
 * NaN into the physics world.
 */
export function fuelAdditionalMassKg(fuelKg: number): number {
  if (!Number.isFinite(fuelKg) || fuelKg <= 0) return 0;
  return fuelKg * FUEL_MASS_SIMULATION_KG_PER_KG;
}
