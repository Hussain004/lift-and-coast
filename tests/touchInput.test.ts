import { describe, expect, it } from "vitest";
import {
  createTouchDriveInput,
  resetTouchDriveInput,
  touchPedalsFromDelta,
  touchSteerFromDelta,
} from "../lib/input/touch";

describe("touch drive input", () => {
  it("maps a rightward steering drag to the vehicle's left-positive convention", () => {
    expect(touchSteerFromDelta(-40, 100)).toBeGreaterThan(0);
    expect(touchSteerFromDelta(40, 100)).toBeLessThan(0);
    expect(touchSteerFromDelta(0, 100)).toBe(0);
  });

  it("uses the vertical pedal stick for throttle and brake", () => {
    expect(touchPedalsFromDelta(-100, 100)).toEqual({ throttle: 1, brake: 0 });
    expect(touchPedalsFromDelta(100, 100)).toEqual({ throttle: 0, brake: 1 });
    const half = touchPedalsFromDelta(0, 100);
    expect(half.throttle).toBe(0);
    expect(half.brake).toBe(0);
  });

  it("clears every channel when a touch control is cancelled", () => {
    const input = createTouchDriveInput();
    input.steer = -0.5;
    input.throttle = 0.8;
    input.brake = 0.2;
    input.steeringActive = true;
    input.pedalActive = true;
    input.overtake = true;
    input.deploy = true;
    resetTouchDriveInput(input);
    expect(input).toEqual({
      steer: 0,
      throttle: 0,
      brake: 0,
      steeringActive: false,
      pedalActive: false,
      overtake: false,
      deploy: false,
    });
  });
});
