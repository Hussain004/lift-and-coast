// Plan section 5, depth feature 4: "Manual gears - sequential paddles
// default, auto-gear assist toggle; simple torque curve + optimal shift
// band; missed shifts cost real time."
//
// Model: rpm is a pure function of wheel speed and the selected gear
// (clutch engaged - the engine can't free-rev at standstill), and the
// engine's thrust at the wheels is the base engine force scaled by a
// torque curve over rpm. The gearbox itself is a small state machine:
// it picks the gear from either the driver's manual shift requests
// (edge-triggered) or an auto policy that keeps rpm inside the torque
// band. Being in the wrong gear costs real time because the torque curve
// falls off at both ends (weak at low rpm, and a hard rev-limiter cut
// past REDLINE_RPM), and any gear choice never exceeds the legacy fixed
// force the whole stability suite was verified against (peak thrust in
// 1st gear at peak torque = exactly DEFAULT_ENGINE_FORCE).
//
// Constants chosen so 1st gear redlines at ~21 m/s and 7th gear has enough
// headroom to let the car run into the low-80s m/s on a long straight. The
// previous 6.89 final ratio redlined at only ~62 m/s, which made the profile's
// old 70 m/s straight-line target unreachable in normal running and made a
// battery deployment look like it did nothing. The deliberately tall final
// gear still lands just above the torque band after the 6th-to-7th shift, so
// it behaves like a real top gear rather than an artificial rev limiter.

export interface GearboxState {
  /** 1-based gear, 1..GEAR_COUNT. */
  gear: number;
  /**
   * Auto-assist active: shifting follows the rpm policy below and manual
   * requests are ignored. Defaults to ON - same reasoning as traction
   * control/ABS in useDriveInput.ts (assists default on until a "Pro"
   * difficulty tier exists); the player toggles it off for manual gears.
   */
  auto: boolean;
}

/** Per-tick driving input the gearbox reacts to. */
export interface GearboxDriverInput {
  /** Signed forward speed, m/s. rpm uses the magnitude. */
  speedMs: number;
  /** Edge request: shift up one gear this tick (manual mode only). */
  shiftUp: boolean;
  /** Edge request: shift down one gear this tick (manual mode only). */
  shiftDown: boolean;
}

// Matches CAR_WHEELS' wheel radius in vehicle.ts - duplicated rather than
// imported to keep this module dependency-free (vehicle.ts imports it, so
// importing back would be a cycle).
const DRIVEN_WHEEL_RADIUS_M = 0.34;
const DRIVEN_WHEEL_CIRCUMFERENCE_M = 2 * Math.PI * DRIVEN_WHEEL_RADIUS_M;

export const GEAR_COUNT = 7;

// Overall ratios (gear ratio x final drive), 1st (shortest) to 7th.
// The first six retain the close, F1-like spread used by the original tuning;
// final is deliberately taller so the car can use the available drag headroom
// instead of sitting on the limiter at 62 m/s.
export const GEAR_RATIOS = [20.3, 16.96, 14.17, 11.83, 9.88, 8.25, 5.6];

// Mild mechanical-advantage taper toward the tall gears - 1st is 1.0 so
// the legacy launch force (DEFAULT_ENGINE_FORCE at peak torque) is
// preserved exactly, and each shift up gives up a small, felt fraction.
export const GEAR_THRUST_FACTORS = [1.0, 0.985, 0.97, 0.955, 0.94, 0.925, 0.91];

export const IDLE_RPM = 3000;
export const REDLINE_RPM = 12000;
// Past this the torque curve collapses - drives forever in a too-short
// gear and you sit at ~40% thrust (the "missed shifts cost real time"
// penalty), downshifting into an over-rev is worse.
export const REV_LIMITER_RPM = 12200;
// Auto policy: shift up just before the redline (the next gear then lands
// at ~9600 rpm, right at the torque peak) and shift down once rpm drops
// out of the useful band (lugging).
export const SHIFT_UP_RPM = 11500;
export const SHIFT_DOWN_RPM = 5500;

// Simple piecewise-linear torque curve (0..1 thrust multiplier over rpm).
// Flat at 1.0 across the working band, steep cliff past the rev limiter.
// Control points: [rpm, multiplier].
const TORQUE_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5],
  [IDLE_RPM, 0.92],
  [7000, 1.0],
  [11000, 1.0],
  [REDLINE_RPM, 0.93],
  [REV_LIMITER_RPM, 0.4],
  [15000, 0.35],
];

export function rpmForGear(speedMs: number, gear: number): number {
  if (gear < 1 || gear > GEAR_COUNT) return IDLE_RPM;
  const wheelRpm = (Math.abs(speedMs) / DRIVEN_WHEEL_CIRCUMFERENCE_M) * 60;
  return Math.max(IDLE_RPM, wheelRpm * GEAR_RATIOS[gear - 1]);
}

/** Thrust multiplier for the gear's own mechanical advantage (1..GEAR_COUNT). */
export function gearThrustFactor(gear: number): number {
  if (gear < 1) return GEAR_THRUST_FACTORS[0];
  if (gear > GEAR_COUNT) return GEAR_THRUST_FACTORS[GEAR_COUNT - 1];
  return GEAR_THRUST_FACTORS[gear - 1];
}

export function createGearboxState(auto = true): GearboxState {
  return { gear: 1, auto };
}

/**
 * Advances the gearbox one tick: auto policy or manual requests, clamped
 * to [1, GEAR_COUNT]. Mutates and returns `state` (same pattern as
 * createEnergySystem's update) so the caller's persistent gear selection
 * survives across ticks.
 */
export function updateGearbox(state: GearboxState, input: GearboxDriverInput): GearboxState {
  const rpm = rpmForGear(input.speedMs, state.gear);
  if (state.auto) {
    if (rpm >= SHIFT_UP_RPM && state.gear < GEAR_COUNT) {
      state.gear += 1;
    } else if (rpm < SHIFT_DOWN_RPM && state.gear > 1) {
      state.gear -= 1;
    }
  } else {
    if (input.shiftUp && state.gear < GEAR_COUNT) state.gear += 1;
    if (input.shiftDown && state.gear > 1) state.gear -= 1;
  }
  return state;
}

/**
 * The torque curve: 0..1 thrust multiplier for a given rpm, piecewise-
 * linear over TORQUE_CURVE (clamped at both ends).
 */
export function engineTorqueMultiplier(rpm: number): number {
  const points = TORQUE_CURVE;
  if (rpm <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (rpm >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [rpmHigh, multHigh] = points[i];
    if (rpm <= rpmHigh) {
      const [rpmLow, multLow] = points[i - 1];
      const t = (rpm - rpmLow) / (rpmHigh - rpmLow);
      return multLow + (multHigh - multLow) * t;
    }
  }
  return last[1];
}