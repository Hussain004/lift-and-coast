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
