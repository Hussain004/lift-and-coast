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
 * Peak friction coefficient at a given normal load (compound grip 1.0 =
 * fresh baseline) - the mu inside peakForceN above, exposed for the racing
 * line's corner-speed cap (see lib/tracks/racingLine.ts), which needs the
 * same load-sensitive grip the physics actually drives on rather than a
 * separately-tuned constant that can drift from it.
 */
export function peakFrictionMu(normalLoadN: number): number {
  if (normalLoadN <= 0) return BASE_MU;
  return BASE_MU * (REFERENCE_LOAD_N / normalLoadN) ** LOAD_SENSITIVITY_EXPONENT;
}

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

export type TireCompoundId = "soft" | "medium" | "hard" | "intermediate" | "wet";

/** The three slicks; inters and wets only earn their keep on a wet track. */
export const isSlick = (id: TireCompoundId): boolean => id === "soft" || id === "medium" || id === "hard";

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
  // Grooved tyres shed heat and wear quickly, especially on a drying track.
  intermediate: { id: "intermediate", degradationPerMeter: FULL_WEAR_FRACTION / (4 * 5891) },
  wet: { id: "wet", degradationPerMeter: FULL_WEAR_FRACTION / (6 * 5891) },
};

/**
 * Weather grip for the fitted compound - the wet-track term that replaces
 * WeatherState.gripMultiplier for the player. Slicks keep the weather's own
 * curve untouched (that is the validated one, and the AI still uses it).
 * Inters peak on a damp track (wetness ~0.35-0.65) and wets on a soaked
 * one; on a dry track both overheat and lose grip. Every value is <= 1, so
 * this composes below the friction safety cap exactly like the weather term
 * it replaces - a wet tyre in the wet only ever loses LESS than a slick.
 */
export function weatherGripForCompound(
  id: TireCompoundId,
  weather: { wetness: number; rainIntensity: number; gripMultiplier: number }
): number {
  const wetness = Math.min(1, Math.max(0, weather.wetness));
  const rain = Math.min(1, Math.max(0, weather.rainIntensity));
  if (id === "intermediate") {
    const curve =
      wetness < 0.35 ? 0.9 + 0.07 * (wetness / 0.35) : wetness < 0.65 ? 0.97 : 0.97 - 0.06 * ((wetness - 0.65) / 0.35);
    return Math.min(1, curve - rain * 0.02);
  }
  if (id === "wet") {
    return Math.min(1, 0.8 + 0.15 * Math.min(1, wetness / 0.7) - rain * 0.02);
  }
  return weather.gripMultiplier;
}

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

/*
 * TYRE PRESSURE (the player's setup slider, road map 11.11). Display-level,
 * +/-3% of grip, exactly as that section specifies.
 *
 * WHY SO SMALL. The peak-grip term in this model is a coefficient on a force
 * that a suspension raycast then has to satisfy, and every other term feeding
 * it (aero grip, load sensitivity, compound wear, weather) only ever
 * multiplies below 1x precisely so no term can push past the measured
 * envelope. A +/-3% band is comfortably inside that convention while still
 * being worth a lap time over a stint; anything larger would be a tyre model
 * change dressed as a setup slider, and would invalidate the AI gates that
 * measure this same grip product at a fixed neutral pressure.
 *
 * THE TRADE, and it is the real one: a lower-pressure tyre has a bigger
 * contact patch, so more peak grip, and a larger carcass to heat, so it takes
 * longer to reach its working temperature. A higher-pressure tyre warms up
 * sooner and gives up a little of that peak. In F1 the low end is the
 * one-lap/qualifying choice and the high end the long-stint choice, and the
 * warm-up half is what makes it a decision rather than a free lunch: the
 * multiplier below is a blend of both, so a cold tyre at the low-pressure end
 * starts up slightly BELOW neutral grip and only passes it once warm.
 */

/** Peak grip as a fraction of the nominal pressure's, +/- TYRE_PRESSURE_GRIP_RANGE. */
export const TYRE_PRESSURE_GRIP_RANGE = 0.03;

/**
 * How far a completely cold low-pressure tyre sits BELOW neutral grip, as a
 * fraction of the warm gain it is owed. Half means a cold tyre at the low end
 * starts 1.5% under neutral, crosses neutral about halfway through the
 * warm-up, and reaches the full +3% once hot. Without a cold penalty the low
 * end would be a free upgrade at every temperature, and the warm-up half of
 * the trade would not exist.
 */
const TYRE_PRESSURE_COLD_PENALTY_FRACTION = 0.5;

/**
 * Grip multiplier for a starting pressure, optionally scaled by how warm the
 * tyre already is. `warmth` is 0 cold and 1 in the working window.
 *
 * Peak (warm) grip runs from 1 + RANGE at the low-pressure end to 1 - RANGE
 * at the high-pressure end, monotonically in the slider. Cold, the whole
 * curve is compressed toward - and below - neutral and its peak moves to the
 * NOMINAL pressure, because a cold low-pressure carcass is floppy with no
 * contact patch while a cold high-pressure one has a small one. The pressure
 * that is best on a cold tyre is therefore not the pressure that is best on a
 * hot one, which is exactly the qualifying-versus-stint decision this slider
 * exists to express.
 */
export function tyrePressureGripScale(pressure: number, warmth = 1): number {
  const clamped = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0.5;
  const warmthFactor = Number.isFinite(warmth) ? Math.min(1, Math.max(0, warmth)) : 1;
  // Signed grip offset from nominal. LOW pressure is the grippy end (a bigger
  // contact patch), so the sign is deliberately inverted against the slider
  // value: +RANGE at pressure 0, -RANGE at pressure 1. This also keeps the
  // curve monotonic in the slider, which the measurement test asserts.
  const gain = (0.5 - clamped) * 2 * TYRE_PRESSURE_GRIP_RANGE;
  if (gain <= 0) return 1 + gain;
  // The grippy (low-pressure) half has to be EARNED by warming up. A cold
  // low-pressure tyre is a big floppy carcass that has not made any contact
  // patch yet, so it is modelled as starting BELOW neutral - by
  // TYRE_PRESSURE_COLD_PENALTY_FRACTION of the gain it will eventually have
  // - and rising linearly through neutral to the full warm gain. That is what
  // makes the low end a qualifying-style choice rather than a free upgrade:
  // out of the pit lane you are slower, and you have to drive the tyre in to
  // collect the grip it was set up for.
  //
  // The high-pressure half only ever gives grip up, at every warmth, so it
  // needs no such treatment and stays unconditionally at or below neutral.
  const warmCredit = -TYRE_PRESSURE_COLD_PENALTY_FRACTION + (1 + TYRE_PRESSURE_COLD_PENALTY_FRACTION) * warmthFactor;
  return 1 + gain * warmCredit;
}

/**
 * Tyre carcass temperature as a 0-1 "warmth", for tyrePressureGripScale.
 *
 * Maps the strategy system's own tyreTemperatureC (see
 * lib/race/strategy.ts, whose thermal grip term peaks at 100 C) onto the
 * 0-1 range, with a window rather than a single point: a tyre is working
 * somewhere around 60-100 C, so warmth is 0 at ambient and 1 once the carcass
 * is properly in, reaching 1 at 100 C. Below the window it ramps linearly.
 *
 * Reusing the strategy temperature rather than inventing a second one is the
 * point: the HUD tyre-temperature readout, the thermal grip term and this
 * slider then all agree about how warm the tyre is, so the player can watch
 * the grip arrive on the same number they are already looking at.
 */
export const TIRE_AMBIENT_C = 24;
/** Temperature at which the carcass is fully in its working window. */
export const TIRE_FULL_WARMTH_C = 100;
export const TIRE_WARMTH_WINDOW_C = 60;

export function computeTireWarmth(tireTemperatureC: number): number {
  if (!Number.isFinite(tireTemperatureC)) return 0;
  if (tireTemperatureC <= TIRE_AMBIENT_C) return 0;
  if (tireTemperatureC >= TIRE_FULL_WARMTH_C) return 1;
  const span = TIRE_FULL_WARMTH_C - TIRE_AMBIENT_C;
  const raw = (tireTemperatureC - TIRE_AMBIENT_C) / span;
  // Remap so warmth is 0 at the bottom of the window and 1 at the top: the
  // working range is the top half, which is where a real tyre lives.
  const windowStart = (TIRE_WARMTH_WINDOW_C - TIRE_AMBIENT_C) / span;
  if (raw <= windowStart) return 0;
  return Math.min(1, (raw - windowStart) / (1 - windowStart));
}
