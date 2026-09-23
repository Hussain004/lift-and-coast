// Gamepad/wheel analog input shaping (plan section 5, "Input shaping":
// "Gamepad/wheel: small deadzone + mild non-linear response curve
// (precision near center)"). Pure functions - the mechanical goal is that
// small stick movements near the center map to proportionally smaller
// vehicle inputs (precision), while the deadzone keeps a relaxed/scratchy
// stick from feeding jitter into the steering.
//
// Mapping (standard "gamepad" mapping, browser Gamepad API:
// https://w3c.github.io/gamepad/):
//   - left stick X (axes[0]): steering (left = -1, right = +1)
//   - left stick Y (axes[1]): throttle forward, brake backward (down = +1
//     throttle, up = -1 brake) - the arcade layout that works on every
//     pad/wheel without a driver
//   - right trigger (buttons[7]) / left trigger (buttons[6]): throttle / brake
//     when they report analog values (additive with the stick, take whichever
//     is larger) on pads that have trigger axes
export const STICK_DEADZONE = 0.12;
// Mild power curve: at 50% stick the vehicle gets ~42% input - extra travel
// where fine control matters, still 1:1 at full deflection.
export const RESPONSE_POWER = 1.25;

/**
 * Deadzone with smooth re-mapping: returns 0 inside the deadzone (plus a
 * small hysteresis-free band right at the edge), then scales the remaining
 * travel so full deflection still maps to 1. Monotonic and continuous.
 */
export function applyAxisDeadzone(value: number, deadzone = STICK_DEADZONE): number {
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  return Math.sign(value) * scaled;
}

/**
 * Mild non-linear response curve (precision near center): sign-preserving,
 * monotonic, |out| <= |in| (never amplifies small inputs, never exceeds 1).
 */
export function applySensitivityCurve(value: number, power = RESPONSE_POWER): number {
  return Math.sign(value) * Math.pow(Math.abs(value), power);
}

/** Full analog shape: deadzone then curve. */
export function shapeAnalogAxis(value: number): number {
  return applySensitivityCurve(applyAxisDeadzone(value));
}

/**
 * Convert the browser's physical stick convention into the vehicle's input
 * convention. The Gamepad API reports a right push as +X, while the driving
 * model (and the keyboard A/D path) uses positive steer for left. Keeping
 * the inversion here makes the sign contract explicit and testable instead
 * of relying on every consumer to remember it.
 */
export function gamepadSteerToVehicle(axis: number): number {
  const shaped = shapeAnalogAxis(axis);
  return shaped === 0 ? 0 : -shaped;
}

/** Split a combined -1..1 pedal axis into independent throttle/brake 0..1 targets. */
export function splitPedalAxis(axis: number): { throttleTarget: number; brakeTarget: number } {
  return {
    throttleTarget: Math.max(0, axis),
    brakeTarget: Math.max(0, -axis),
  };
}

export interface GamepadAxisInput {
  /** -1..1, left = negative. */
  steer: number;
  /** -1..1, positive = throttle (stick down). */
  pedalAxis: number;
  /** 0..1 additive throttle (right trigger), 0 when unpressed/unsupported. */
  triggerThrottle: number;
  /** 0..1 additive brake (left trigger), 0 when unpressed/unsupported. */
  triggerBrake: number;
}

/**
 * Reads the raw (pre-shaping) axes from a connected Gamepad. Robust to
 * pads that report fewer axes/buttons than the standard mapping.
 */
export function readGamepadAxes(pad: Pick<Gamepad, "axes" | "buttons">): GamepadAxisInput {
  const steer = pad.axes[0] ?? 0;
  const pedalAxis = pad.axes[1] ?? 0;
  const triggerThrottle = pad.buttons[7]?.value ?? 0;
  const triggerBrake = pad.buttons[6]?.value ?? 0;
  return { steer, pedalAxis, triggerThrottle, triggerBrake };
}

/** A control is "engaged" past the deadzone - used to let the pad take
 * over that channel from the keyboard. */
export function engaged(axis: number, deadzone = STICK_DEADZONE): boolean {
  return Math.abs(axis) > deadzone;
}

/**
 * First connected gamepad, or null. Defensive about the environment
 * (SSR/tests have no navigator / no Gamepad API).
 */
export function findConnectedGamepad(): Gamepad | null {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return null;
  }
  const pads = navigator.getGamepads();
  if (!pads) return null;
  for (const pad of pads) {
    if (pad && pad.connected) return pad;
  }
  return null;
}