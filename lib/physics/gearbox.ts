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
  /** Fixed-step filtered wheel speed used for auto shifts and engine rpm. */
  filteredSpeedMs: number;
  /** False until the first update seeds the filter from the real speed. */
  speedInitialized: boolean;
  /** Brief lockout after a shift, preventing an immediate 7-to-6 bounce. */
  shiftCooldownTicks: number;
}

/** Per-tick driving input the gearbox reacts to. */
export interface GearboxDriverInput {
  /** Signed forward speed, m/s. rpm uses the magnitude. */
  speedMs: number;
  /** Edge request: shift up one gear this tick (manual mode only). */
  shiftUp: boolean;
  /** Edge request: shift down one gear this tick (manual mode only). */
  shiftDown: boolean;
  /**
   * Edge request: select reverse (see REVERSE_GEAR). Honoured in BOTH auto
   * and manual mode, and only below REVERSE_ENGAGE_SPEED_MS - reverse is a
   * recovery tool, not a driving gear, and an auto gearbox that dropped into
   * it mid-corner would be a brake failure.
   */
  selectReverse?: boolean;
}

// Matches CAR_WHEELS' wheel radius in vehicle.ts - duplicated rather than
// imported to keep this module dependency-free (vehicle.ts imports it, so
// importing back would be a cycle).
const DRIVEN_WHEEL_RADIUS_M = 0.34;
const DRIVEN_WHEEL_CIRCUMFERENCE_M = 2 * Math.PI * DRIVEN_WHEEL_RADIUS_M;

export const GEAR_COUNT = 7;

/**
 * Reverse is gear 0 - below first, not a negative gear, so every existing
 * `gear >= 1` assumption (ratio indexing, HUD, audio, replay frames) keeps
 * working unchanged and only reverse has to be handled explicitly.
 */
export const REVERSE_GEAR = 0;

/**
 * Reverse ratio. A real reverse is TALL, not short - a fraction of first gear -
 * because it only ever has to move the car, not accelerate it.
 */
export const REVERSE_RATIO = 7.4;

/**
 * Thrust factor in reverse. Deliberately well under first gear's 1.0: reverse
 * has to be able to back the car out of a gravel trap or reverse out of a
 * mistake, not launch it backwards down the pit lane. 0.5 keeps reverse to
 * walking pace, which is the entire point of it.
 */
const REVERSE_THRUST_FACTOR = 0.5;

/**
 * Speed under which reverse may be selected, m/s. Engaging it while rolling
 * forward would be an instant speed reversal of a 220kg car, so reverse is
 * only available from (near) a standstill - the same interlock a real gearbox
 * has.
 */
export const REVERSE_ENGAGE_SPEED_MS = 2.5;

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
// Auto downshifts wait below the normal lugging line. Without this small
// hysteresis a single noisy top-speed sample could drop 7th to 6th and the
// next normal sample immediately shift back again.
const SHIFT_DOWN_HYSTERESIS_RPM = 250;
const SHIFT_COOLDOWN_TICKS = 5;
const SPEED_FILTER_ALPHA = 0.18;

// Simple piecewise-linear torque curve (0..1 thrust multiplier over rpm).
// Flat at 1.0 across the working band, steep cliff past the rev limiter.
// Control points: [rpm, multiplier].
const TORQUE_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.5],
  [IDLE_RPM, 0.92],
  [7000, 1.0],
  [11000, 1.0],
  [11900, 0.98],
  [REDLINE_RPM, 0.96],
  [12080, 0.82],
  [12140, 0.62],
  [REV_LIMITER_RPM, 0.4],
  [15000, 0.35],
];

export function rpmForGear(speedMs: number, gear: number): number {
  if (gear === REVERSE_GEAR) {
    // Reverse reads the same way as any other gear: engine speed from wheel
    // speed through the reverse ratio, floored at idle.
    const wheelRpm = (Math.abs(speedMs) / DRIVEN_WHEEL_CIRCUMFERENCE_M) * 60;
    return Math.max(IDLE_RPM, wheelRpm * REVERSE_RATIO);
  }
  if (gear < 1 || gear > GEAR_COUNT) return IDLE_RPM;
  const wheelRpm = (Math.abs(speedMs) / DRIVEN_WHEEL_CIRCUMFERENCE_M) * 60;
  return Math.max(IDLE_RPM, wheelRpm * GEAR_RATIOS[gear - 1]);
}

/** Thrust multiplier for the gear's own mechanical advantage (1..GEAR_COUNT). */
export function gearThrustFactor(gear: number): number {
  if (gear === REVERSE_GEAR) return REVERSE_THRUST_FACTOR;
  if (gear < 1) return GEAR_THRUST_FACTORS[0];
  if (gear > GEAR_COUNT) return GEAR_THRUST_FACTORS[GEAR_COUNT - 1];
  return GEAR_THRUST_FACTORS[gear - 1];
}

/** True when the gearbox is in reverse. */
export function isReverse(gear: number): boolean {
  return gear === REVERSE_GEAR;
}

export function createGearboxState(auto = true): GearboxState {
  return {
    gear: 1,
    auto,
    filteredSpeedMs: 0,
    speedInitialized: false,
    shiftCooldownTicks: 0,
  };
}

/** Stable wheel speed for drivetrain consumers (gearbox, HUD, and audio).
 * The first sample seeds the filter so a standing start does not spend the
 * opening ticks lugging; subsequent samples reject single-frame speed
 * spikes from the raycast controller. */
export function gearboxSpeedMs(state: GearboxState, fallbackMs = 0): number {
  return state.speedInitialized ? state.filteredSpeedMs : Math.abs(fallbackMs);
}

/**
 * Advances the gearbox one tick: auto policy or manual requests, clamped
 * to [1, GEAR_COUNT]. Mutates and returns `state` (same pattern as
 * createEnergySystem's update) so the caller's persistent gear selection
 * survives across ticks.
 */
export function updateGearbox(state: GearboxState, input: GearboxDriverInput): GearboxState {
  const rawSpeed = Math.abs(input.speedMs);
  if (!Number.isFinite(rawSpeed)) return state;
  if (!state.speedInitialized) {
    state.filteredSpeedMs = rawSpeed;
    state.speedInitialized = true;
  } else {
    state.filteredSpeedMs += (rawSpeed - state.filteredSpeedMs) * SPEED_FILTER_ALPHA;
  }

  // Reverse, handled before either mode's own policy because it applies to
  // both. Edge-triggered, speed-gated, and it cancels any pending shift
  // cooldown - the driver is asking for a specific gear, not nudging the
  // current one.
  if (input.selectReverse) {
    if (rawSpeed <= REVERSE_ENGAGE_SPEED_MS) {
      state.gear = REVERSE_GEAR;
      state.shiftCooldownTicks = 0;
    }
    // Above the gate the request is ignored rather than queued: honouring it
    // a second later would drop the car into reverse while it was still
    // rolling forward.
    return state;
  }

  // Out of reverse and not being asked back into it: a shift-up (or the
  // throttle, which the caller signals as a shift-up when reverse gear is
  // selected) returns to first. Speed-gated the same way, so the car cannot
  // be flipped into forward while travelling backwards.
  if (state.gear === REVERSE_GEAR) {
    if (input.shiftUp && rawSpeed <= REVERSE_ENGAGE_SPEED_MS) {
      state.gear = 1;
    }
    return state;
  }

  if (!state.auto) {
    // Manual mode remains edge-triggered and deliberately bypasses the
    // automatic hysteresis/cooldown: a paddle request is the driver's
    // decision, not a noisy sensor sample.
    if (input.shiftUp && state.gear < GEAR_COUNT) state.gear += 1;
    if (input.shiftDown && state.gear > 1) state.gear -= 1;
    return state;
  }

  if (state.shiftCooldownTicks > 0) {
    state.shiftCooldownTicks -= 1;
    return state;
  }

  const rpm = rpmForGear(state.filteredSpeedMs, state.gear);
  if (rpm >= SHIFT_UP_RPM && state.gear < GEAR_COUNT) {
    state.gear += 1;
    state.shiftCooldownTicks = SHIFT_COOLDOWN_TICKS;
  } else if (rpm < SHIFT_DOWN_RPM - SHIFT_DOWN_HYSTERESIS_RPM && state.gear > 1) {
    state.gear -= 1;
    state.shiftCooldownTicks = SHIFT_COOLDOWN_TICKS;
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