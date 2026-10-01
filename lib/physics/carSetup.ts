
/**
 * Car setup: the player's pre-race choice of how their car is built.
 *
 * SCOPE, and it is a deliberate one. This applies to the PLAYER's car only.
 * The AI runs the same `createCarController` physics the player does, so a
 * setup that changed handling would move the AI too - and every stability
 * gate in this repo (tests/trackAIStability.test.ts, the ace harnesses) is a
 * measurement of the AI at a FIXED setup. Changing the shared dynamics would
 * silently invalidate all of them, and Suzuka in particular is already a
 * documented knife edge (see lib/ai/pathFollower.ts's Suzuka crossover
 * block). Real F1 works the same way round: you set up your car, the
 * opposition is not your problem. So the AI keeps the neutral default below
 * and stays exactly as validated.
 *
 * WHY NOT BRAKE BALANCE. It is the obvious third slider and the user asked
 * for it, so this records the reason it is absent rather than leaving a
 * silent gap. Front brake bias was already tried on this physics and measured
 * strictly worse: 0.6-0.7 to the front gave near-flips at 0.59 rad where the
 * even front/rear split is clean, because in this tire model the pitch torque
 * follows FRONT-axle force, so loading the axle that already carries the
 * transferred weight overloads it (see DEFAULT_BRAKE_FORCE's own comment in
 * vehicle.ts). Shipping a slider into that region would hand the player a
 * one-click flip. It could be added later bounded to a measured-safe range,
 * but "bounded to a range nobody has measured yet" is exactly the kind of
 * value this codebase has been bitten by shipping (see the same file's
 * boost and rev-axis notes), so it is left out rather than guessed at.
 *
 * Every value here is a pure function of the setup with no I/O, so it is
 * testable without a physics world and safe to call per frame.
 */

import { FINAL_DRIVE_NOMINAL, finalDriveLabel, normalizeFinalDriveScale } from "./gearbox";
import { tyrePressureGripScale } from "./tireModel";

/** Ride height trim, 0 (lowest, most downforce) to 1 (highest, least). */
export type RideHeight = number;

/** Aero trim, 0 (lowest drag) to 1 (most downforce). */
export type AeroTrim = number;

/**
 * Final-drive trim, expressed as the gearbox ratio multiplier itself rather
 * than as a 0-1 slider, because its neutral value is 1 and NOT 0.5 like the
 * other two. It is carried in this object so the setup screen, the URL and
 * localStorage all treat it like any other setup choice, and the gearbox
 * module owns the range (see lib/physics/gearbox.ts's FINAL_DRIVE_MIN, which
 * documents the measured terminal-speed trade).
 */
export type FinalDriveScale = number;

/**
 * Starting tyre pressure, 0 (low) to 1 (high). Low pressure is the grippy end
 * and the slow-to-warm end; high pressure warms up sooner and gives up a
 * little peak grip. See tyrePressureGripScale in lib/physics/tireModel.ts.
 */
export type TyrePressure = number;

export interface CarSetup {
  rideHeight: RideHeight;
  aeroTrim: AeroTrim;
  /** Optional in the type so a pre-existing stored setup still type-checks;
   *  read it through normalizeCarSetup, which always fills it in. */
  finalDrive?: FinalDriveScale;
  tyrePressure?: TyrePressure;
}

export const RIDE_HEIGHT_MIN = 0;
export const RIDE_HEIGHT_MAX = 1;
/** Ride height as a fraction of nominal. Real cars run a small window, and
 *  this model's downforce term is linear, so the useful range is narrow on
 *  purpose - a full 0-100% swing would be a different car, not a setup. */
export const RIDE_HEIGHT_NOMINAL = 0.5;

export const AERO_TRIM_MIN = 0;
export const AERO_TRIM_MAX = 1;

export const TYRE_PRESSURE_MIN = 0;
export const TYRE_PRESSURE_MAX = 1;
/** Neutral pressure. The thermal curve is written around this, so a player
 *  who never touches the slider gets exactly the validated warm-up. */
export const TYRE_PRESSURE_NOMINAL = 0.5;

export const DEFAULT_CAR_SETUP: CarSetup = {
  // The neutral build: nominal ride height, and the aero mode the whole
  // physics model is written around (AeroMode's "identity" state, per
  // aero.ts). The AI runs exactly this.
  rideHeight: RIDE_HEIGHT_NOMINAL,
  aeroTrim: 1,
  finalDrive: FINAL_DRIVE_NOMINAL,
  tyrePressure: TYRE_PRESSURE_NOMINAL,
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

/**
 * A slider value that is safe to use, or null when it is not.
 *
 * The null is load-bearing: a non-finite or out-of-range value must fall back
 * to the DEFAULT, not to the nearest bound. Falling back to a bound would mean
 * a junk `?rh=banana` silently hands the player the most downforce the slider
 * can give, which is the opposite of "ignore what I could not understand".
 */
function usableSlider(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clamp(value, min, max);
}

/** Coerces anything (a URL param, a stale localStorage blob) into a valid
 *  setup, rather than trusting it. Never throws, never returns NaN. */
export function normalizeCarSetup(input: Partial<CarSetup> | null | undefined): CarSetup {
  if (input === null || input === undefined) return { ...DEFAULT_CAR_SETUP };
  return {
    rideHeight: usableSlider(
      input.rideHeight,
      DEFAULT_CAR_SETUP.rideHeight,
      RIDE_HEIGHT_MIN,
      RIDE_HEIGHT_MAX
    ),
    aeroTrim: usableSlider(
      input.aeroTrim,
      DEFAULT_CAR_SETUP.aeroTrim,
      AERO_TRIM_MIN,
      AERO_TRIM_MAX
    ),
    // Both new fields go through their own normalizing helpers rather than
    // usableSlider: the final drive's range is not 0-1 (its neutral is 1) and
    // it is owned and measured in gearbox.ts, so there is exactly one place
    // that knows its bounds.
    finalDrive: normalizeFinalDriveScale(input.finalDrive),
    tyrePressure: usableSlider(
      input.tyrePressure,
      DEFAULT_CAR_SETUP.tyrePressure ?? TYRE_PRESSURE_NOMINAL,
      TYRE_PRESSURE_MIN,
      TYRE_PRESSURE_MAX
    ),
  };
}

/** Ride height's effect on downforce.
 *
 *  A lower ride height gives a more efficient underfloor: more downforce for
 *  the same speed, and in this model downforce IS grip (see
 *  computeDownforceN and racingLine.ts's maxLateralAccelMs2, which both
 *  scale with it). The trade is that a low car is less tolerant of the
 *  surface - it skips over kerbs rather than settling on them - so the
 *  downforce gain is capped below 1.0 at the very bottom of the range and
 *  never exceeds the validated high-downforce reference.
 *
 *  Deliberately a MULTIPLIER ON AN EXISTING TERM, not a new force: it
 *  therefore composes with the aero mode, the damage model, the AI's
 *  assumptions and every existing gate instead of sitting beside them.
 */
export function rideHeightDownforceScale(rideHeight: RideHeight): number {
  const clamped = clamp(rideHeight, RIDE_HEIGHT_MIN, RIDE_HEIGHT_MAX);
  // Nominal is exactly 1.0 (no change to today's car); the low end is
  // capped at +12% and the high end at -8%, so the whole slider stays a
  // setup rather than a different car.
  const offset = (RIDE_HEIGHT_NOMINAL - clamped) * (clamped < RIDE_HEIGHT_NOMINAL ? 0.24 : 0.16);
  return 1 + offset;
}

/** Extra downforce from the aero trim, on top of the mode's own multiplier.
 *  Neutral (1.0) exactly at trim 1, tapering to 0.9 at trim 0 - a bounded
 *  ~10% either way, so the trim cannot make the car meaningfully faster than
 *  the configuration the gates measured. */
export function aeroDownforceScale(setup: CarSetup): number {
  return 0.9 + 0.1 * clamp(setup.aeroTrim, AERO_TRIM_MIN, AERO_TRIM_MAX);
}

/** Drag from the aero trim: a higher trim is a bigger wing, so more drag.
 *  Paired with the downforce scale above so the trade is real. */
export function aeroDragScale(setup: CarSetup): number {
  return 1 + 0.12 * clamp(setup.aeroTrim, AERO_TRIM_MIN, AERO_TRIM_MAX);
}

/** The combined downforce multiplier this setup applies. */
export function setupDownforceScale(setup: CarSetup): number {
  return rideHeightDownforceScale(setup.rideHeight) * aeroDownforceScale(setup);
}

/** The combined drag multiplier this setup applies. */
export function setupDragScale(setup: CarSetup): number {
  return aeroDragScale(setup);
}

/** True when this setup is the neutral build - drives the STANDARD button's
 *  selected state, so the button reflects reality rather than assuming. */
export function isDefaultCarSetup(setup: CarSetup): boolean {
  return (
    setup.rideHeight === DEFAULT_CAR_SETUP.rideHeight &&
    setup.aeroTrim === DEFAULT_CAR_SETUP.aeroTrim &&
    (setup.finalDrive ?? FINAL_DRIVE_NOMINAL) === FINAL_DRIVE_NOMINAL &&
    (setup.tyrePressure ?? TYRE_PRESSURE_NOMINAL) === TYRE_PRESSURE_NOMINAL
  );
}

/** The final drive this setup asks for, always in the gearbox's own units. */
export function setupFinalDriveScale(setup: CarSetup): number {
  return normalizeFinalDriveScale(setup.finalDrive);
}

/**
 * The setup's total grip contribution from tyre pressure, as a plain
 * multiplier to hand to the same grip product every other term already
 * multiplies into (see applyLoadSensitiveFriction's sharedGripScale in
 * vehicle.ts). At the neutral pressure this is exactly 1, so a player who
 * never opens the slider drives the validated car.
 */
export function setupTyreGripScale(setup: CarSetup): number {
  return tyrePressureGripScale(setup.tyrePressure ?? TYRE_PRESSURE_NOMINAL);
}

/**
 * A short human label for the setup screen's readout. Phrased as what the
 * car does rather than as numbers, because a bare "0.65" tells a player
 * nothing about whether they have made it faster or slower.
 */
export function carSetupRideLabel(setup: CarSetup): string {
  return setup.rideHeight < RIDE_HEIGHT_NOMINAL - 0.05
    ? "LOW"
    : setup.rideHeight > RIDE_HEIGHT_NOMINAL + 0.05
      ? "HIGH"
      : "STANDARD";
}

export function carSetupAeroLabel(setup: CarSetup): string {
  return setup.aeroTrim < 0.45 ? "LOW DRAG" : setup.aeroTrim > 0.55 ? "MAX DOWNFORCE" : "BALANCED";
}

/** Tyre pressure, as the two things it actually trades. */
export function carSetupPressureLabel(setup: CarSetup): string {
  const pressure = setup.tyrePressure ?? TYRE_PRESSURE_NOMINAL;
  if (pressure < TYRE_PRESSURE_NOMINAL - 0.05) return "LOW (grip)";
  if (pressure > TYRE_PRESSURE_NOMINAL + 0.05) return "HIGH (warm-up)";
  return "STANDARD";
}

/** Both halves in one phrase, for anywhere a single string is wanted. */
export function carSetupLabel(setup: CarSetup): string {
  const low = setup.rideHeight < RIDE_HEIGHT_NOMINAL - 0.05;
  const high = setup.rideHeight > RIDE_HEIGHT_NOMINAL + 0.05;
  const drag = setup.aeroTrim < 0.45;
  const down = setup.aeroTrim > 0.55;
  const ride = low ? "LOW" : high ? "HIGH" : "STANDARD";
  const aero = drag ? "LOW DRAG" : down ? "MAX DOWNFORCE" : "BALANCED";
  // Only the parts the player has actually moved: this string is the setup
  // chip, and a four-part label for an untouched car would be noise.
  const extras: string[] = [];
  if (setupFinalDriveScale(setup) !== FINAL_DRIVE_NOMINAL) {
    extras.push(finalDriveLabel(setupFinalDriveScale(setup)));
  }
  const pressure = setup.tyrePressure ?? TYRE_PRESSURE_NOMINAL;
  if (pressure < TYRE_PRESSURE_NOMINAL - 0.05 || pressure > TYRE_PRESSURE_NOMINAL + 0.05) {
    extras.push(carSetupPressureLabel(setup));
  }
  return [`${ride} · ${aero}`, ...extras].join(" · ");
}
