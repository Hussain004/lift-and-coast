import { applyAxisDeadzone, applySensitivityCurve } from "./gamepad";

/**
 * Shared mutable values written by the on-screen controls and read by the
 * player's physics tick. A ref avoids routing 60Hz touch movement through
 * React state or re-rendering the entire race scene.
 */
export interface TouchDriveInput {
  /** Vehicle convention: positive steers left, negative steers right. */
  steer: number;
  throttle: number;
  brake: number;
  steeringActive: boolean;
  pedalActive: boolean;
  overtake: boolean;
  deploy: boolean;
}

export function createTouchDriveInput(): TouchDriveInput {
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    steeringActive: false,
    pedalActive: false,
    overtake: false,
    deploy: false,
  };
}

export function resetTouchDriveInput(input: TouchDriveInput | null | undefined): void {
  if (!input) return;
  input.steer = 0;
  input.throttle = 0;
  input.brake = 0;
  input.steeringActive = false;
  input.pedalActive = false;
  input.overtake = false;
  input.deploy = false;
}

const TOUCH_DEADZONE = 0.08;
const TOUCH_RESPONSE_POWER = 1.18;

function shapedTouchAxis(value: number): number {
  return applySensitivityCurve(applyAxisDeadzone(value, TOUCH_DEADZONE), TOUCH_RESPONSE_POWER);
}

/** Map a horizontal stick delta to the vehicle's left-positive convention. */
export function touchSteerFromDelta(deltaMeters: number, radiusMeters: number): number {
  if (radiusMeters <= 0) return 0;
  const shaped = shapedTouchAxis(Math.max(-1, Math.min(1, deltaMeters / radiusMeters)));
  return shaped === 0 ? 0 : -shaped;
}

/** Map a vertical stick delta: up is throttle, down is brake. */
export function touchPedalsFromDelta(
  deltaMeters: number,
  radiusMeters: number
): { throttle: number; brake: number } {
  if (radiusMeters <= 0) return { throttle: 0, brake: 0 };
  const normalized = Math.max(-1, Math.min(1, deltaMeters / radiusMeters));
  const value = shapedTouchAxis(normalized);
  return {
    throttle: Math.max(0, -value),
    brake: Math.max(0, value),
  };
}
