/**
 * In-car telemetry: the live per-wheel and chassis-g state a real F1 engineer
 * reads off a car, formatted for display.
 *
 * The headless harness already records this (see lib/ai/harness.ts's
 * onTelemetry: per-wheel contact flags, suspension force and length,
 * longitudinal and lateral impulses, tilt and speed). This module is the
 * in-game counterpart, and it is deliberately PURE - it takes a raw sample
 * and returns render-ready strings and normalised bar values - so the
 * interesting logic is unit-testable without a DOM or a physics world, and
 * so the HUD component stays a dumb renderer.
 *
 * What this shows is chosen to be what the existing bottom bar does NOT
 * already show. That bar carries gear, speed, RPM, ERS, driver inputs,
 * sector times, tyre compound, assists and damage; this adds the engineer's
 * view underneath it: how load is distributed across the four corners, how
 * much grip each corner actually has, whether it is on the ground at all,
 * and the combined-g trace that makes a balance problem visible.
 */

/** One corner's live state. */
export interface WheelTelemetry {
  /** Vertical load through the corner, newtons. */
  loadN: number;
  /** Effective grip coefficient for this corner, 0..1, after surface,
   * compound and weather (see vehicle.ts's applyLoadSensitiveFriction). */
  grip: number;
  /** True while this corner is carrying the car. */
  inContact: boolean;
  /** Corner surface temperature, celsius. */
  temperatureC: number;
}

/** Which corner a wheel is, in the order the UI lays them out. */
export type WheelCorner = "frontLeft" | "frontRight" | "rearLeft" | "rearRight";

/** A single telemetry sample for the player's car. */
export interface TelemetrySample {
  wheels: Record<WheelCorner, WheelTelemetry>;
  /** Combined acceleration in the car's own frame, g. */
  lateralG: number;
  longitudinalG: number;
  /** Vertical load total, for the balance readouts. */
  totalLoadN: number;
  /** Slip angle, degrees. */
  slipAngleDeg: number;
  /** Yaw rate, degrees per second. */
  yawRateDegS: number;
  /** Engine speed, rpm - the panel normalises its own tacho scale. */
  rpm: number;
  redlineRpm: number;
}

/**
 * A neutral sample: a car sitting still on the ground with no grip, no load
 * and no motion.
 *
 * The telemetry ref is created with this and then MUTATED IN PLACE every
 * physics step, rather than replaced, so a 60Hz update allocates nothing. It
 * has to exist before the first update for that reason - the panel reads the
 * ref on its own rAF and needs something valid to read on the very first
 * frame, and the writer needs a truthy object to mutate.
 */
export function emptyTelemetrySample(): TelemetrySample {
  const wheel = (): WheelTelemetry => ({ loadN: 0, grip: 0, inContact: true, temperatureC: 20 });
  return {
    wheels: {
      frontLeft: wheel(),
      frontRight: wheel(),
      rearLeft: wheel(),
      rearRight: wheel(),
    },
    lateralG: 0,
    longitudinalG: 0,
    totalLoadN: 0,
    slipAngleDeg: 0,
    yawRateDegS: 0,
    rpm: 0,
    redlineRpm: 15_000,
  };
}

/** Normalised 0..1 bar value, clamped. */
export function normalizeBar(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return 0;
  if (max === min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/**
 * Grip bar fill, 0..1. Deliberately maps a WIDE grip range across the bar:
 * a real car lives between about 0.45 (rain, worn) and 1.0 (dry, fresh), so
 * a scale pinned to 0..1 would show every normal corner as "nearly full"
 * and hide the difference that matters.
 */
export const GRIP_BAR_MIN = 0.4;
export function gripBarFill(grip: number): number {
  return normalizeBar(grip, GRIP_BAR_MIN, 1);
}

/**
 * Load bar fill, 0..1, relative to the static corner load. A real F1 corner
 * carries well over its static figure in a fast corner and under it on
 * kerbs and under braking, so the bar is scaled to twice static: half height
 * is the neutral reference and a fully-loaded corner fills it.
 */
export function loadBarFill(loadN: number, staticLoadN: number): number {
  if (!(staticLoadN > 0)) return 0;
  return normalizeBar(loadN, 0, staticLoadN * 2);
}

/** Front/rear load balance as a percentage on the front axle. */
export function frontLoadPercent(sample: TelemetrySample): number {
  const front = sample.wheels.frontLeft.loadN + sample.wheels.frontRight.loadN;
  const total = sample.totalLoadN;
  if (!(total > 0)) return 50;
  return (front / total) * 100;
}

/**
 * Understeer/oversteer read from where the grip has gone, the way a driver
 * feels it. Front corner grip that has collapsed while the rear still has
 * grip available is understeer; the reverse is oversteer. Returns -1..1,
 * negative understeer and positive oversteer.
 *
 * This is a comparison of available grip, not a claim about slip angles: it
 * says which end has lost the ability to put its force down, which is what
 * actually determines where the car goes.
 */
export function balanceBias(sample: TelemetrySample): number {
  const front =
    sample.wheels.frontLeft.grip * sample.wheels.frontLeft.loadN +
    sample.wheels.frontRight.grip * sample.wheels.frontRight.loadN;
  const rear =
    sample.wheels.rearLeft.grip * sample.wheels.rearLeft.loadN +
    sample.wheels.rearRight.grip * sample.wheels.rearRight.loadN;
  const total = front + rear;
  if (!(total > 0)) return 0;
  // Normalised so a neutral car reads 0 and either end dominating reads
  // toward +/-1, with the exponent keeping small imbalances visible.
  // Sign: front minus rear. A front that has lost grip contributes LESS than
  // the rear, so the difference goes negative - which is understeer, matching
  // this function's documented convention (negative understeer, positive
  // oversteer).
  const bias = (front - rear) / total;
  return Math.max(-1, Math.min(1, bias * 4));
}

export const BALANCE_LABELS: ReadonlyArray<{ max: number; label: string }> = [
  { max: -0.34, label: "UNDERSTEER" },
  { max: -0.1, label: "FRONT LIGHT" },
  { max: 0.1, label: "NEUTRAL" },
  { max: 0.34, label: "REAR LIGHT" },
  { max: Infinity, label: "OVERSTEER" },
];

export function balanceLabel(bias: number): string {
  for (const band of BALANCE_LABELS) {
    if (bias < band.max) return band.label;
  }
  return "NEUTRAL";
}

/**
 * Signed g string. The integer part is zero-padded to two characters so every
 * reading is the same width in its sign column - a readout whose glyph count
 * changes as the value crosses zero is what makes a live g-meter shimmer.
 * Single figures are the whole realistic range (about 5g lateral in an F1
 * car), so this covers it without truncation.
 */
export function formatG(value: number): string {
  if (!Number.isFinite(value)) return "+0.0";
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "-" : "+";
  // toFixed(1) is already exactly sign + digit + point + digit for every
  // single-figure magnitude, which is the whole realistic range, so no
  // padding is needed - padding it was what put the space in.
  return `${sign}${magnitude.toFixed(1)}`;
}

export function formatLoad(loadN: number): string {
  // The non-finite fallback keeps the same width as a real reading: a
  // degenerate load should not change the glyph count and make the column
  // jump.
  if (!Number.isFinite(loadN)) return "0.0kN";
  return `${(loadN / 1000).toFixed(1)}kN`;
}

export function formatTemp(celsius: number): string {
  if (!Number.isFinite(celsius)) return "--";
  return `${Math.round(celsius)}°`;
}

/**
 * G-g plot geometry: where this sample's combined acceleration lands inside
 * the trace box, as a fraction of the box's half-extent. The real figure is
 * about 5g of lateral in an F1 car, so the box is scaled to that and a
 * sample beyond it pins to the edge rather than vanishing.
 */
export const GG_PLOT_MAX_G = 5;
export function ggPlotPoint(lateralG: number, longitudinalG: number): {
  x: number;
  y: number;
} {
  return {
    x: normalizeBar(lateralG, -GG_PLOT_MAX_G, GG_PLOT_MAX_G) * 2 - 1,
    y: normalizeBar(longitudinalG, -GG_PLOT_MAX_G, GG_PLOT_MAX_G) * 2 - 1,
  };
}

/** Tacho fill against the redline, for the panel's own compact bar. */
export function rpmBarFill(rpm: number, redlineRpm: number): number {
  return normalizeBar(rpm, 0, redlineRpm);
}

/** The corners in the order a plan view of the car reads them. */
export const WHEEL_ORDER: ReadonlyArray<WheelCorner> = [
  "frontLeft",
  "frontRight",
  "rearLeft",
  "rearRight",
];

/**
 * Slip angle in degrees: the angle between where the car is pointing and where
 * it is actually going.
 *
 * Pure and separate from the component so it can be tested, because the sign
 * convention is the easy thing to get backwards. Forward is (-sin yaw,
 * -cos yaw) and right is (cos yaw, -sin yaw), the same convention the rest of
 * the game uses for the minimap and the player's own input readouts. A
 * positive result is the car sliding toward its right, which is what a driver
 * means by "the back stepping out".
 */
export function slipAngleDeg(
  yawRad: number,
  velocityXMs: number,
  velocityZMs: number
): number {
  const speed = Math.hypot(velocityXMs, velocityZMs);
  // Below walking pace the heading is noise and the angle is meaningless;
  // returning 0 keeps the readout still instead of spinning.
  if (speed < 1) return 0;
  const forwardMs = velocityXMs * -Math.sin(yawRad) + velocityZMs * -Math.cos(yawRad);
  const lateralMs = velocityXMs * Math.cos(yawRad) - velocityZMs * Math.sin(yawRad);
  // Rolling backwards, or sliding so far the velocity is behind the nose,
  // has no meaningful slip angle - atan2 would wrap to ~180 degrees and the
  // readout would snap. Zero is the honest answer: the car is not sliding
  // forward off its line.
  if (forwardMs <= 0) return 0;
  return (Math.atan2(lateralMs, forwardMs) * 180) / Math.PI;
}

/** Where each corner sits in the 2x2 plan-view grid, as [column, row]. */
export const WHEEL_GRID_POSITION: Record<WheelCorner, readonly [number, number]> = {
  frontLeft: [0, 0],
  frontRight: [1, 0],
  rearLeft: [0, 1],
  rearRight: [1, 1],
};
