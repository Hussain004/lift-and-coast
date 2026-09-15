export interface TireForceInputs {
  /** Lateral slip angle, radians. Sign gives force direction. */
  slipAngleRad: number;
  /** Longitudinal slip ratio, dimensionless. Sign gives force direction. */
  slipRatio: number;
  /** Normal load on this wheel, Newtons (from weight transfer). */
  normalLoadN: number;
  /** Compound grip multiplier - 1.0 is the baseline compound. */
  compoundGrip: number;
}

export interface TireForcesN {
  lateralForceN: number;
  longitudinalForceN: number;
}

// A simplified stand-in for the Pacejka Magic Formula (plan section 5):
// peak grip coefficient at a reference load, softening sub-linearly as load
// rises (real tires gain less grip per added kg the harder they're loaded -
// this is what makes trail-braking and throttle modulation matter, since
// dumping all the load onto one end doesn't multiply its grip for free).
const BASE_MU = 1.6;
const REFERENCE_LOAD_N = 2000;
const LOAD_SENSITIVITY_EXPONENT = 0.15;

const LATERAL_SLIP_AT_PEAK_RAD = 0.16;
const LONGITUDINAL_SLIP_AT_PEAK = 0.12;

function peakForceN(normalLoadN: number, compoundGrip: number): number {
  if (normalLoadN <= 0) return 0;
  const mu = BASE_MU * (REFERENCE_LOAD_N / normalLoadN) ** LOAD_SENSITIVITY_EXPONENT;
  return mu * normalLoadN * compoundGrip;
}

const LOAD_SCALE_MIN = 0.6;
const LOAD_SCALE_MAX = 1.5;

/**
 * The same sub-linear load sensitivity as the tire force curve above,
 * expressed as a dimensionless multiplier around 1.0 at `referenceLoadN`
 * instead of a Newton force - for modulating a friction *parameter*
 * (e.g. Rapier's own wheelFrictionSlip/wheelSideFrictionStiffness) rather
 * than computing a force directly. Clamped: a near-zero load would
 * otherwise blow this up toward infinity, which is meaningless since a
 * wheel that unloaded has ~0 grip regardless of the multiplier.
 */
export function loadSensitivityScale(normalLoadN: number, referenceLoadN: number): number {
  if (normalLoadN <= 0) return LOAD_SCALE_MAX;
  const raw = (referenceLoadN / normalLoadN) ** LOAD_SENSITIVITY_EXPONENT;
  return Math.min(LOAD_SCALE_MAX, Math.max(LOAD_SCALE_MIN, raw));
}

// Rises from 0 to 1 as slip goes from 0 to slipAtPeak, then relaxes back
// down as slip increases further - "grip rises to a peak then falls off"
// (plan section 5), without needing the full Magic Formula's B/C/D/E
// coefficients. Odd function: negative slip gives a force of the same
// magnitude in the opposite direction.
function slipCurveShape(slip: number, slipAtPeak: number): number {
  if (slipAtPeak <= 0) return 0;
  const x = slip / slipAtPeak;
  return (2 * x) / (1 + x * x);
}

/**
 * Computes lateral and longitudinal tire forces from slip, load, and
 * compound grip, then clamps their combined magnitude to the friction
 * circle (plan section 5) - using more grip for cornering leaves less
 * available for braking/traction at the same instant, and vice versa.
 */
export function computeTireForces(inputs: TireForceInputs): TireForcesN {
  const maxForceN = peakForceN(inputs.normalLoadN, inputs.compoundGrip);
  const rawLateralN = maxForceN * slipCurveShape(inputs.slipAngleRad, LATERAL_SLIP_AT_PEAK_RAD);
  const rawLongitudinalN =
    maxForceN * slipCurveShape(inputs.slipRatio, LONGITUDINAL_SLIP_AT_PEAK);

  const magnitudeN = Math.hypot(rawLateralN, rawLongitudinalN);
  if (magnitudeN <= maxForceN || magnitudeN === 0) {
    return { lateralForceN: rawLateralN, longitudinalForceN: rawLongitudinalN };
  }
  const scale = maxForceN / magnitudeN;
  return { lateralForceN: rawLateralN * scale, longitudinalForceN: rawLongitudinalN * scale };
}

export type TireCompoundId = "soft" | "medium" | "hard";

export interface TireCompound {
  id: TireCompoundId;
  /** Fraction of peak grip lost per meter driven on this compound. */
  degradationPerMeter: number;
}

// Plan section 5, depth feature 3. Peak (fresh-tire) grip is deliberately
// IDENTICAL across all three compounds (see computeCompoundGripMultiplier
// below - it only ever multiplies downward from 1.0) rather than soft
// starting above baseline: applyLoadSensitiveFriction's sideFrictionStiffness
// is already capped at its own safe ceiling (a documented flip trigger
// above 1.0 - see that function's comment), and everything feeding into it
// today (aero grip, load sensitivity) only ever scales below 1x for exactly
// that reason. A compound that started above 1x grip would silently do
// nothing extra in corners (clamped away) while still boosting straight-
// line grip unclamped - an incoherent, untested combination. Keeping peak
// grip at parity and varying only how fast it falls off keeps every new
// number inside the already-validated "multiplies below 1x" regime, so no
// existing stability tuning needs re-verification.
//
// Degradation rates are a felt-pacing choice, not motorsport data: chosen
// so continuous full-throttle driving on softs shows a clearly perceptible
// grip loss within about 2 laps of Silverstone (~5891m/lap), medium around
// 5 laps, hard around 10 - fast enough to actually experience the strategic
// tradeoff in a single test session, without a multi-lap race/championship
// mode to make a slower falloff observable.
const FULL_WEAR_FRACTION = 0.15;
export const TIRE_COMPOUNDS: Record<TireCompoundId, TireCompound> = {
  soft: { id: "soft", degradationPerMeter: FULL_WEAR_FRACTION / (2 * 5891) },
  medium: { id: "medium", degradationPerMeter: FULL_WEAR_FRACTION / (5 * 5891) },
  hard: { id: "hard", degradationPerMeter: FULL_WEAR_FRACTION / (10 * 5891) },
};

// Floor on how much grip degradation alone can take away - a compound run
// well past its intended life should feel notably worse, never undrivable
// (there's no pit stop/tire change system yet to force a fresh set, so a
// floor keeps the mechanic a strategic annoyance rather than a hard wall).
export const MIN_COMPOUND_GRIP_FRACTION = 0.85;

/**
 * Grip remaining as a fraction of peak (1.0 = fresh), given how far the car
 * has been driven since this compound was fitted. Feeds into
 * applyLoadSensitiveFriction's existing grip-scale product in vehicle.ts
 * alongside the aero and load-sensitivity terms - one more factor that only
 * ever multiplies below 1x (see TIRE_COMPOUNDS' comment for why that
 * matters here).
 */
export function computeCompoundGripMultiplier(compound: TireCompound, wornMeters: number): number {
  return Math.max(MIN_COMPOUND_GRIP_FRACTION, 1 - wornMeters * compound.degradationPerMeter);
}
