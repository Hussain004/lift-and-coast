/**
 * Tilt steering: map a phone's orientation sensors to the steering axis.
 *
 * PURE, like everything else in lib/input: no DOM, no listeners, no globals.
 * The component that owns the deviceorientation listener feeds readings in and
 * reads a steer value out, which is what makes the mapping unit-testable at
 * all - and the mapping is the part that actually has to be right.
 *
 * WHY THIS IS SEPARATE FROM touch.ts rather than folded into it: the two input
 * methods have genuinely different failure modes. A stick is absolute - the
 * knob is where your thumb is. Tilt is RELATIVE to however you happen to be
 * holding the phone when the session starts, which is why calibration here is
 * not a nicety but the difference between the control working and the car
 * driving off on its own.
 *
 * THE AXIS PROBLEM, and the honest caveat. `DeviceOrientationEvent` reports
 * `gamma` (rotation about the device's own Y axis) and `beta` (about its X),
 * but the game is played in landscape, where the device has been rotated and
 * the axis the player thinks they are tilting is neither of those. The mapping
 * below is the standard one for landscape play:
 *
 *   portrait (0)      -> gamma
 *   landscape (90)    -> beta
 *   upside down (180) -> -gamma
 *   landscape (270)   -> -beta
 *
 * The AXIS is mechanical and can be derived. The SIGN is not: it depends on
 * which way the player is holding the phone, and whether the browser reports
 * the rotation the way this table assumes cannot be established without a
 * device in hand. So the sign is a persisted setting (TILT_STEER_INVERT)
 * rather than a constant, and the calibration gesture doubles as the check -
 * a player who tilts left and the car goes right flips one toggle rather than
 * editing a constant. Anyone with a real device should confirm this before
 * trusting it; it is the one number in this file that is reasoned rather than
 * measured.
 */

import { applyAxisDeadzone, applySensitivityCurve } from "./gamepad";

/** A single orientation reading, in degrees. */
export interface TiltReading {
  /** Left/right rotation about the device's Y axis, -90..90. */
  gamma: number;
  /** Front/back rotation about the device's X axis, -180..180. */
  beta: number;
}

/**
 * `screen.orientation.angle`, normalised. The DOM value is -90 rather than 270
 * on some browsers, so the two spellings of the same rotation have to collapse
 * to one before anything is compared against it.
 */
export type ScreenAngle = 0 | 90 | 180 | 270;

export function normalizeScreenAngle(raw: number | null | undefined): ScreenAngle {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const wrapped = ((Math.round(raw / 90) * 90) % 360 + 360) % 360;
  return (wrapped === 90 || wrapped === 180 || wrapped === 270 ? wrapped : 0) as ScreenAngle;
}

/**
 * The one reading that matters for steering, in the device's own frame.
 *
 * See the header for the table and for why the sign is a setting rather than a
 * constant. Kept separate from the calibration so the axis choice and the
 * zeroing are independently testable - they are different mistakes.
 */
export function tiltAxisDegrees(reading: TiltReading, angle: ScreenAngle): number {
  if (!Number.isFinite(reading.gamma) || !Number.isFinite(reading.beta)) return 0;
  switch (angle) {
    case 90:
      return reading.beta;
    case 180:
      return -reading.gamma;
    case 270:
      return -reading.beta;
    case 0:
    default:
      return reading.gamma;
  }
}

export interface TiltCalibration {
  /** Neutral reading on the chosen axis, degrees. */
  neutralDegrees: number;
  /** True once the player has held the phone where they want to drive from. */
  calibrated: boolean;
}

export function createTiltCalibration(): TiltCalibration {
  return { neutralDegrees: 0, calibrated: false };
}

/**
 * Records the current pose as neutral.
 *
 * Explicitly a gesture rather than a sample: the alternative - calibrating to
 * whatever the very first sensor reading happens to be - catches the phone
 * mid-motion on load and leaves the player driving with a permanent offset.
 * Averaging a few readings is the cheap middle ground and is what this does,
 * because a single frame taken during the tap is itself noisy.
 */
export function calibrateTilt(
  calibration: TiltCalibration,
  reading: TiltReading,
  angle: ScreenAngle
): TiltCalibration {
  calibration.neutralDegrees = tiltAxisDegrees(reading, angle);
  calibration.calibrated = true;
  return calibration;
}

/**
 * Tilt for full lock, in degrees. Deliberately small: this is a wrist and a
 * forearm, not a shoulder, and a large range means the player is fighting the
 * limit instead of driving. 22 degrees is a comfortable roll that most people
 * can reach comfortably while holding a phone in two hands.
 */
export const TILT_RANGE_DEGREES = 22;

/**
 * Dead zone either side of neutral, as a FRACTION of the range. A phone at
 * rest still reports a degree or two of drift, and without this the car
 * wanders on its own at a standstill.
 */
export const TILT_DEADZONE_FRACTION = 0.12;

const TILT_RESPONSE_POWER = 1.35;

export interface TiltOptions {
  /** Flip the sign, for a player whose device reports the other way. */
  invert?: boolean;
  /** Range for full lock; defaults to TILT_RANGE_DEGREES. */
  rangeDegrees?: number;
}

/**
 * Steering from an orientation reading, in the vehicle's left-positive
 * convention (the same one touchSteerFromDelta and the gamepad both use, so
 * the three input methods cannot disagree about which way "left" is).
 *
 * Returns 0 before calibration rather than steering from an uncalibrated
 * reading: a car that immediately starts turning because the player happened
 * to open the session lying down is worse than one that waits for a gesture.
 */
export function tiltSteer(
  calibration: TiltCalibration,
  reading: TiltReading,
  angle: ScreenAngle,
  options: TiltOptions = {}
): number {
  if (!calibration.calibrated) return 0;
  const range = options.rangeDegrees ?? TILT_RANGE_DEGREES;
  if (!(range > 0)) return 0;
  const delta = tiltAxisDegrees(reading, angle) - calibration.neutralDegrees;
  const signed = options.invert ? -delta : delta;
  // Normalize to -1..1, then shape it with the SAME deadzone and response
  // curve the other two input methods use, so a player switching between
  // stick and tilt does not also have to learn a different feel.
  const normalized = Math.max(-1, Math.min(1, signed / range));
  const shaped = applySensitivityCurve(
    applyAxisDeadzone(normalized, TILT_DEADZONE_FRACTION),
    TILT_RESPONSE_POWER
  );
  // Vehicle convention: positive is left. Tilt axis positive is clockwise
  // rotation in the browser's report, which is a right turn, hence the
  // negation. This is the same sign flip touchSteerFromDelta applies.
  return shaped === 0 ? 0 : -shaped;
}

/**
 * True when the device actually reports orientation.
 *
 * Checked before offering the mode at all: on a desktop with no sensor the
 * listener simply never fires, and without this the player is given a control
 * that silently does nothing. It is a capability check, not a permission
 * check - iOS needs requestPermission(), which is a user gesture, so the
 * caller has to do that itself.
 */
export function isTiltSupported(win: Partial<Window> | null | undefined): boolean {
  // Typed loosely on purpose: DeviceOrientationEvent is not declared on
  // lib.dom's Window in every TS version, and this is a runtime capability
  // probe whose whole job is to answer "does this browser have it".
  const api = (win as { DeviceOrientationEvent?: unknown } | null | undefined)?.DeviceOrientationEvent;
  return typeof api !== "undefined" && api !== null;
}

/**
 * iOS 13+ requires an explicit, user-gesture-initiated permission request.
 * Returns true when nothing needed doing, so the caller can treat it as
 * "permission granted either way".
 */
export async function requestTiltPermission(): Promise<boolean> {
  const api = (globalThis as { DeviceOrientationEvent?: { requestPermission?: () => Promise<PermissionState> } })
    .DeviceOrientationEvent;
  if (!api || typeof api.requestPermission !== "function") return true;
  try {
    return (await api.requestPermission()) === "granted";
  } catch {
    // A rejected permission (or a browser that throws rather than resolving)
    // is a normal outcome, not a crash: the caller falls back to sticks.
    return false;
  }
}
