const GRAVITY_MS2 = 9.81;

export interface VehicleGeometry {
  massKg: number;
  wheelbaseM: number;
  trackWidthM: number;
  /** Height of the center of gravity above the ground, in meters. */
  cgHeightM: number;
  /** Fraction of static weight on the front axle, 0..1 (0.5 = 50/50). */
  frontWeightBias: number;
}

export interface WheelLoadsN {
  frontLeft: number;
  frontRight: number;
  rearLeft: number;
  rearRight: number;
}

/**
 * Per-wheel normal load in Newtons from static weight distribution plus
 * longitudinal/lateral load transfer under acceleration - the load-transfer
 * model Rapier's raycast wheels don't provide on their own (plan section 5,
 * depth feature 1), and the input a tire slip-curve model needs to produce
 * realistic trail-braking/throttle-modulation behavior.
 *
 * Simplified: instantaneous linear transfer with no suspension/roll-center
 * dynamics (no transient overshoot, lateral transfer split evenly between
 * axles rather than by front/rear roll stiffness). A wheel's load is
 * clamped at zero rather than letting the excess redistribute elsewhere -
 * physically, load driven past zero means the chassis is actually lifting
 * that corner, which is a rotation this module doesn't model. Revisit if
 * the clamped case needs to feed back into chassis attitude directly.
 *
 * Sign convention: positive longitudinalAccel = accelerating forward
 * (shifts load to the rear), positive lateralAccel = shifts load to the
 * right-side wheels.
 */
export function computeWheelLoads(
  geometry: VehicleGeometry,
  longitudinalAccelMs2: number,
  lateralAccelMs2: number
): WheelLoadsN {
  const totalWeightN = geometry.massKg * GRAVITY_MS2;
  const staticFrontN = totalWeightN * geometry.frontWeightBias;
  const staticRearN = totalWeightN * (1 - geometry.frontWeightBias);

  const longTransferN =
    (geometry.massKg * longitudinalAccelMs2 * geometry.cgHeightM) / geometry.wheelbaseM;
  const frontAxleN = staticFrontN - longTransferN;
  const rearAxleN = staticRearN + longTransferN;

  const latTransferN =
    (geometry.massKg * lateralAccelMs2 * geometry.cgHeightM) / geometry.trackWidthM;

  const clamp = (n: number) => Math.max(0, n);
  return {
    frontLeft: clamp(frontAxleN / 2 - latTransferN / 2),
    frontRight: clamp(frontAxleN / 2 + latTransferN / 2),
    rearLeft: clamp(rearAxleN / 2 - latTransferN / 2),
    rearRight: clamp(rearAxleN / 2 + latTransferN / 2),
  };
}
