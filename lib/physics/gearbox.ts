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
  /**
   * The player's final-drive choice as a multiplier on every gear ratio
   * (see FINAL_DRIVE_TRIM below). 1 is the neutral, as-validated gearing.
   *
   * PLAYER ONLY, like every other setup slider in this project: it lives in
   * the gearbox STATE rather than as a module global precisely so the AI's
   * createGearboxState() call keeps its default and every stability gate
   * stays a measurement of the car those gates were written against. It is
   * deliberately a field and not an argument threaded through every rpm
   * call, because the alternative is a global - and a global would silently
   * move the AI the first time a player touched the slider.
   */
  finalDriveScale: number;
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

/*
 * FINAL DRIVE (setup slider, player only - see CarSetup's header for why
 * every setup control here is player-only).
 *
 * A final drive is a single extra ratio after the gearbox, so scaling it
 * scales the ratio set: the effect lands on rpm-per-metre, and therefore on
 * both WHERE the automatic box shifts and where on the torque curve any
 * given road speed sits. Scale > 1 (a longer overall ratio) turns the engine
 * faster per metre, so the top gear reaches its shift point and its rev
 * ceiling at a LOWER road speed: less top speed. Scale < 1 is the opposite.
 *
 * WHY IT TOUCHES THE TOP GEAR ONLY, which is a measured result rather than a
 * preference. Scaling the whole set was tried first and is a ONE-WAY PENALTY
 * in this physics: GEAR_THRUST_FACTORS tapers monotonically with gear number,
 * so any scale that brings the early upshifts forward just spends more of the
 * launch sitting in a taller, weaker gear. Measured on a standing start, a
 * whole-set scale of 0.95 cost 0.43 s to 200 km/h (6.43 s vs 6.00 s) and
 * gained no terminal speed, because the ceiling here is drag-limited rather
 * than gear-limited. Worse, at 0.93-0.94 it produced a genuine defect: the
 * 6-7 upshift point (52.8 m/s) landed just ABOVE 6th's own drag equilibrium
 * (52.58 m/s), so the car asymptoted to 52.6 m/s in 6th and never reached
 * 200 km/h at all. Restricting the trim to the top gear leaves 0-200 exactly
 * at neutral (6.00 s at every point on the range), keeps the launch gears
 * bit-identical, and still moves the terminal speed across a felt 5.4 m/s.
 *
 * WHY THIS IS SAFE, in the terms this codebase cares about:
 *
 *  - It cannot raise the force CEILING. The delivered thrust is still
 *    baseEngineForce * engineTorqueMultiplier(rpm) * gearThrustFactor(gear)
 *    clamped by the same BOOSTED_ENGINE_FORCE_CAP as always, gearThrustFactor
 *    is untouched, and a scale of 1 is an exact identity on every number the
 *    validated car was measured with. The trim moves the car along the
 *    existing torque CURVE, never above its cap.
 *  - The AI never sees it (see GearboxState.finalDriveScale).
 *  - The range is deliberately narrow, and the per-slider measurement lives in
 *    tests/carSetupFinalDrive.test.ts. Measured terminal speeds are 77.90 /
 *    76.66 / 72.52 m/s at 0.94 / 1.00 / 1.06, with 0-200 unchanged at 6.00 s
 *    and maxTilt 0.084 rad throughout. Past about 1.06 the top gear sits at
 *    the edge of the torque band and the setting stops changing anything
 *    measurable (1.06 and 1.20 both give 72.52 m/s), which is why the top of
 *    the range stops there.
 */
export const FINAL_DRIVE_MIN = 0.94;
export const FINAL_DRIVE_MAX = 1.06;
/** Neutral: bit-identical to the validated as-shipped gearing. */
export const FINAL_DRIVE_NOMINAL = 1;

/**
 * Clamps an arbitrary value (a URL param, a stale prefs blob) into the
 * slider's usable band. Non-finite falls back to the NEUTRAL default rather
 * than to a bound, for the same reason carSetup's usableSlider does: a junk
 * ?fd=banana must not hand the player an end of the range.
 */
export function normalizeFinalDriveScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return FINAL_DRIVE_NOMINAL;
  return Math.min(FINAL_DRIVE_MAX, Math.max(FINAL_DRIVE_MIN, value));
}

/** The gear ratio actually in use, final drive included. */
export function effectiveGearRatio(gear: number, finalDriveScale = 1): number {
  if (gear < 1 || gear > GEAR_COUNT) return 1;
  // MEASURED (tests/carSetupFinalDrive.test.ts): scaling the WHOLE set is a
  // one-way penalty in this physics, because GEAR_THRUST_FACTORS tapers
  // monotonically with gear number - so any scale that shifts upshifts
  // earlier spends more of the run in a taller, weaker gear, and the only
  // possible upside (top speed) is drag-limited, not gear-limited. A
  // top-gear-only trim is therefore the only shape of this control that can
  // pay the player anything, and it is the shape measured here.
  const scale = gear === GEAR_COUNT ? normalizeFinalDriveScale(finalDriveScale) : 1;
  return GEAR_RATIOS[gear - 1] * scale;
}

/**
 * Human phrasing for the setup screen, as what the car does rather than as
 * a number (see carSetupLabel's note on why a bare "0.94" helps nobody).
 * Direction matches the measured trade: a longer ratio (scale > 1) revs the
 * engine out sooner and costs top speed, a shorter one buys top speed.
 */
export function finalDriveLabel(scale: number): string {
  if (scale > FINAL_DRIVE_NOMINAL + 0.005) return "LONG (less top speed)";
  if (scale < FINAL_DRIVE_NOMINAL - 0.005) return "SHORT (more top speed)";
  return "STANDARD";
}

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

/**
 * Engine speed for a wheel speed in a given gear. `finalDriveScale` defaults
 * to 1 so every existing call site (the player, the AI, the harness, the
 * tests) is unchanged and the neutral setup stays an exact no-op - see
 * FINAL_DRIVE_MIN's block for why the final drive only moves rpm.
 */
export function rpmForGear(speedMs: number, gear: number, finalDriveScale = 1): number {
  if (gear === REVERSE_GEAR) {
    // Reverse reads the same way as any other gear: engine speed from wheel
    // speed through the reverse ratio, floored at idle. The final drive is
    // NOT applied to reverse: it is a single fixed recovery ratio, and a
    // player who winds the final drive to its tall end must not be able to
    // select a reverse that cannot move the car out of a gravel trap.
    const wheelRpm = (Math.abs(speedMs) / DRIVEN_WHEEL_CIRCUMFERENCE_M) * 60;
    return Math.max(IDLE_RPM, wheelRpm * REVERSE_RATIO);
  }
  if (gear < 1 || gear > GEAR_COUNT) return IDLE_RPM;
  const wheelRpm = (Math.abs(speedMs) / DRIVEN_WHEEL_CIRCUMFERENCE_M) * 60;
  return Math.max(IDLE_RPM, wheelRpm * effectiveGearRatio(gear, finalDriveScale));
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

/**
 * `finalDriveScale` defaults to neutral (1), so every existing caller -
 * AICar.tsx, the AI harness, all the gearbox tests - gets the exact gearing
 * they were validated with. The player passes their setup's value.
 */
export function createGearboxState(auto = true, finalDriveScale = FINAL_DRIVE_NOMINAL): GearboxState {
  return {
    gear: 1,
    auto,
    finalDriveScale: normalizeFinalDriveScale(finalDriveScale),
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

  // The shift policy reads rpm through the state's final drive, so moving the
  // slider moves the whole shift schedule - that is the whole mechanism, and
  // it is why the delivered force is untouched (see FINAL_DRIVE_MIN's block).
  const rpm = rpmForGear(state.filteredSpeedMs, state.gear, state.finalDriveScale);
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