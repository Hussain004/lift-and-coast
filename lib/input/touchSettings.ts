export type TouchStickSize = "small" | "medium" | "large";

export const TOUCH_STICK_SIZE_OPTIONS: readonly TouchStickSize[] = ["small", "medium", "large"];
export const DEFAULT_TOUCH_STICK_SIZE: TouchStickSize = "medium";

const TOUCH_STICK_SIZE_KEY = "lift-and-coast.touch-stick-size.v1";

/**
 * How the player steers on a touchscreen.
 *
 * "sticks" is the two-thumb joystick layout and stays the default, because it
 * is the only one of the three that needs no permission prompt and works on
 * every device. "tilt" needs a deviceorientation stream and, on iOS, an
 * explicit permission granted from a tap. "buttons" is left/right halves with
 * pedal pads, for players who find a floating stick imprecise.
 */
export type TouchControlMode = "sticks" | "tilt" | "buttons";

export const TOUCH_CONTROL_MODE_OPTIONS: readonly TouchControlMode[] = ["sticks", "tilt", "buttons"];
export const DEFAULT_TOUCH_CONTROL_MODE: TouchControlMode = "sticks";

const TOUCH_CONTROL_MODE_KEY = "lift-and-coast.touch-control-mode.v1";
const TOUCH_STEER_INVERT_KEY = "lift-and-coast.tilt-steer-invert.v1";

export function parseTouchControlMode(raw: string | null): TouchControlMode {
  return raw === "tilt" || raw === "buttons" || raw === "sticks" ? raw : DEFAULT_TOUCH_CONTROL_MODE;
}

export function loadTouchControlMode(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): TouchControlMode {
  if (!storage) return DEFAULT_TOUCH_CONTROL_MODE;
  try {
    return parseTouchControlMode(storage.getItem(TOUCH_CONTROL_MODE_KEY));
  } catch {
    return DEFAULT_TOUCH_CONTROL_MODE;
  }
}

export function saveTouchControlMode(
  mode: TouchControlMode,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(TOUCH_CONTROL_MODE_KEY, mode);
  } catch {
    // Privacy mode or a full quota must not break driving.
  }
}

/**
 * Whether to flip the tilt steering sign.
 *
 * Persisted rather than hard-coded because the sign of the browser's
 * orientation report is the one part of the tilt mapping that cannot be
 * established without a device in hand (see lib/input/tilt.ts). A player whose
 * car turns the wrong way flips this instead of editing a constant. Defaults
 * to un-flipped, which is the conventional report order.
 */
export function loadTiltSteerInvert(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(TOUCH_STEER_INVERT_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTiltSteerInvert(
  invert: boolean,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(TOUCH_STEER_INVERT_KEY, invert ? "1" : "0");
  } catch {
    // Non-fatal, as above.
  }
}

export function parseTouchStickSize(raw: string | null): TouchStickSize {
  return raw === "small" || raw === "medium" || raw === "large"
    ? raw
    : DEFAULT_TOUCH_STICK_SIZE;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadTouchStickSize(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): TouchStickSize {
  if (!storage) return DEFAULT_TOUCH_STICK_SIZE;
  try {
    return parseTouchStickSize(storage.getItem(TOUCH_STICK_SIZE_KEY));
  } catch {
    return DEFAULT_TOUCH_STICK_SIZE;
  }
}

export function saveTouchStickSize(
  size: TouchStickSize,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(TOUCH_STICK_SIZE_KEY, size);
  } catch {
    // Privacy mode or a full storage quota should not break driving.
  }
}
