/**
 * Slip measurement and per-wheel assist modulation (IMPROVEMENTS.md
 * findings F9-adjacent assists, phases A2/A3-lite).
 *
 * Until now the game's ABS and traction control were: ABS = the 0.5 s
 * anti-flip brake ramp (gated by the UI's ABS boolean), TC = a blanket
 * steering-and-speed cut on the shared throttle (a low-speed wheelspin
 * guard, not wheel-state control). Neither looked at a wheel's actual
 * rolling state. This module measures the slip ratio per wheel from the
 * cumulative wheel angle the vehicle controller already reports
 * (controller.wheelRotation, radians) and applies two REAL systems:
 *
 *  - Wheelspin cut (TC): a per-driven-wheel engine-force reduction when the
 *    wheel's surface speed outruns ground speed, ramped by the car's forward
 *    speed so launches still light the tyres up gradually (a standing start
 *    legitimately spins) - this is the assist's job at pace, not a wall.
 *  - Lockup release (ABS): a per-wheel brake release when the wheel slows
 *    below ground speed, on top of (never instead of) the untouchable 0.5 s
 *    anti-flip application ramp. ABS on = the wheel is brought back to grip
 *    and the stop shortens; ABS off = raw lockup, flat spots included.
 *
 * Player-only by construction: nothing in here runs for the AI or the
 * headless sims. The AI paths keep their validated assist/pace budgets,
 * and applyCarControls treats an absent SlipAssist as bit-identical stock
 * behaviour.
 */

/**
 * Wheel radius for the surface-speed term. Mirrors CAR_WHEELS[i].radius
 * (all four wheels 0.34 m in this sim) - kept as a local constant so this
 * module doesn't import vehicle.ts, which itself imports this module;
 * promote the source if the radii ever diverge.
 */
const WHEEL_RADIUS = 0.34;

/** Below this reference speed there is no trustworthy slip to modulate. */
const SLIP_REFERENCE_SPEED_MS = 3;
/** Forward speed at which TC reaches full authority (launch stays alive). */
const TC_AUTHORITY_FULL_SPEED_MS = 12;

/** Slip ratio where TC starts asking the engine to back off. */
export const TC_CUT_SLIP_START = 0.13;
/** Slip ratio where TC considers the wheel useless. */
export const TC_CUT_SLIP_ZERO = 0.4;
export const TC_MIN_SCALE = 0.05;

/**
 * ABS feedback law. A locked wheel (slip far more negative than target) is
 * eased off by ABS_RELEASE_STEP_PER_TICK per tick; a wheel back inside the
 * band lets pressure recover at ABS_RECOVER_STEP_PER_TICK. The 0.04 deadband
 * above target hysteresis holds pressure where the wheel sat at peak grip,
 * which is where real ABS hovers - the tyre then works at its own μ, not at
 * any fixed force. Floor is ABS_MIN_SCALE; the anti-flip 0.5 s application
 * ramp in useDriveInput.ts is untouched and governs the pedal, not the slip.
 */
export const ABS_TARGET_SLIP = -0.1;
export const ABS_DEADBAND = 0.04;
export const ABS_RELEASE_STEP_PER_TICK = 0.1;
export const ABS_RECOVER_STEP_PER_TICK = 0.07;
export const ABS_MIN_SCALE = 0.25;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Wheelspin cut multiplier for a signed slip ratio, 1 when healthy. */
export function tractionCutForSlip(slipRatio: number, forwardSpeedMs?: number): number {
  if (!Number.isFinite(slipRatio) || slipRatio <= TC_CUT_SLIP_START) return 1;
  const t = clamp01((slipRatio - TC_CUT_SLIP_START) / (TC_CUT_SLIP_ZERO - TC_CUT_SLIP_START));
  const cut = 1 - (1 - TC_MIN_SCALE) * t;
  if (forwardSpeedMs === undefined) return cut;
  const authority = clamp01((Math.abs(forwardSpeedMs) - SLIP_REFERENCE_SPEED_MS) / (TC_AUTHORITY_FULL_SPEED_MS - SLIP_REFERENCE_SPEED_MS));
  return 1 - (1 - cut) * authority;
}

/**
 * ABS release for a signed slip ratio given the current modulation state.
 * A locked wheel (slip < target) releases pressure; a wheel comfortably back
 * inside the deadband regains it. Exported for tests; the tracker advances
 * the modulation itself, callers normally use `snapshot().absRelease`.
 */
export function absReleaseStep(
  slipRatio: number,
  currentRelease: number
): number {
  if (!Number.isFinite(slipRatio)) return currentRelease;
  if (slipRatio < ABS_TARGET_SLIP) {
    return Math.max(ABS_MIN_SCALE, currentRelease - ABS_RELEASE_STEP_PER_TICK);
  }
  if (slipRatio > ABS_TARGET_SLIP + ABS_DEADBAND) {
    return Math.min(1, currentRelease + ABS_RECOVER_STEP_PER_TICK);
  }
  return currentRelease;
}

/**
 * Signed slip ratio along the rolling direction: (surfaceSpeed - groundSpeed)
 * over the larger magnitude, in [-1, 1]. Positive = the wheel is hauling
 * ahead of the ground (wheelspin); negative = the wheel is below ground
 * speed (lockup); 0 for rolling with the road. Returns 0 below the
 * reference speed, where ratio is meaningless.
 */
export function slipRatioFor(wheelSurfaceSpeedMs: number, forwardSpeedMs: number): number {
  const v = Math.abs(forwardSpeedMs);
  if (v < SLIP_REFERENCE_SPEED_MS || !Number.isFinite(wheelSurfaceSpeedMs)) return 0;
  // Standardise to the rolling direction so lockup and spin read the same
  // in reverse: both the wheel's angular speed and the ground speed flip
  // sign together, so comparing magnitudes is identical to flipping both.
  const w = forwardSpeedMs >= 0 ? wheelSurfaceSpeedMs : -wheelSurfaceSpeedMs;
  const denominator = Math.max(Math.abs(w), v, SLIP_REFERENCE_SPEED_MS);
  return (w - v) / denominator;
}

export interface WheelAngleSource {
  wheelRotation(index: number): number | null;
}

export type SlipEstimate = {
  /** Per-wheel signed slip ratio, CAR_WHEELS order. */
  readonly perWheel: readonly [number, number, number, number];
  /**
   * Per-wheel ABS pressure multiplier, 1 = full commanded braking and
   * ABS_MIN_SCALE = fully relaxed; advanced per tick by the modulation law
   * (lock below target -> release, or rolling fine -> recover).
   */
  readonly absRelease: readonly [number, number, number, number];
};

export interface SlipTracker {
  /** Recompute the estimate from fresh wheel angles. */
  update(
    source: WheelAngleSource,
    forwardSpeedMs: number,
    dt: number
  ): SlipEstimate;
  /** The most recent estimate, or zeros before the first update. */
  snapshot(): SlipEstimate;
}

/**
 * Per-wheel slip tracker. Stateful across ticks (it differentiates
 * cumulative wheel angles); one instance per car, created once and reused.
 * Feeds the TC/ABS assists; also exposed for the future telemetry/HUD
 * brake/lockup readouts.
 */
export function createSlipTracker(): SlipTracker {
  const previous = [0, 0, 0, 0];
  let initialized = false;
  let currentSlip: [number, number, number, number] = [0, 0, 0, 0];
  let currentAbsRelease: [number, number, number, number] = [1, 1, 1, 1];

  function update(
    source: WheelAngleSource,
    forwardSpeedMs: number,
    dt: number
  ): SlipEstimate {
    if (!Number.isFinite(dt) || dt <= 0) {
      return { perWheel: currentSlip, absRelease: currentAbsRelease };
    }
    const nextSlip: [number, number, number, number] = [0, 0, 0, 0];
    const nextAbsRelease: [number, number, number, number] = [1, 1, 1, 1];
    for (let i = 0; i < 4; i++) {
      const angle = source.wheelRotation(i);
      if (angle === null || angle === undefined || !Number.isFinite(angle)) {
        nextSlip[i] = currentSlip[i];
        nextAbsRelease[i] = currentAbsRelease[i];
        continue;
      }
      if (!initialized) {
        // The first observation only seeds history - there is no rolling
        // reference yet, and a stationary wheel against a moving ground is
        // not actionable information.
        nextSlip[i] = 0;
        nextAbsRelease[i] = 1;
        previous[i] = angle;
        continue;
      }
      const previousAngle = previous[i];
      const deltaAngle = angle - previousAngle;
      // Cumulative wheel angle, counter-rotating sign pairs: in reverse the
      // spin direction and the ground speed flip together (slipRatioFor
      // flips both back to the forward convention).
      const angularSpeed = deltaAngle / dt;
      const surface = angularSpeed * WHEEL_RADIUS;
      const slip = slipRatioFor(surface, forwardSpeedMs);
      nextSlip[i] = slip;
      nextAbsRelease[i] = absReleaseStep(slip, currentAbsRelease[i]);
      previous[i] = angle;
    }
    initialized = true;
    currentSlip = nextSlip;
    currentAbsRelease = nextAbsRelease;
    return { perWheel: currentSlip, absRelease: currentAbsRelease };
  }

  function snapshot(): SlipEstimate {
    return { perWheel: currentSlip, absRelease: currentAbsRelease };
  }

  return { update, snapshot };
}

/**
 * The assist bundle for the shared control path (IMPROVEMENTS.md A2/A3):
 * the player passes this, everyone else omits it.
 */
export interface SlipAssist {
  tracker: SlipTracker;
  /** Per-wheel lockup release on brake (replaces nothing, adds a real ABS). */
  absEnabled: boolean;
  /** Per-driven-wheel wheelspin cut on throttle (adds to the steer/speed TC). */
  tractionEnabled: boolean;
  /**
   * Brake effectiveness multiplier per wheel (IMPROVEMENTS.md A9) - the
   * brake model's cold-bite/fade curve applied to the applied-brake
   * command, computed one tick earlier. Optional so the bundle still runs
   * with only slip assists; omitted = healthy brakes.
   */
  brakeEffectiveness?: readonly [number, number, number, number];
}
