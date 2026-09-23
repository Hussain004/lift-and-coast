import { describe, expect, it } from "vitest";
import {
  RESPONSE_POWER,
  STICK_DEADZONE,
  applyAxisDeadzone,
  applySensitivityCurve,
  engaged,
  gamepadSteerToVehicle,
  readGamepadAxes,
  shapeAnalogAxis,
  splitPedalAxis,
} from "../lib/input/gamepad";

describe("applyAxisDeadzone", () => {
  it("zeroes everything inside the deadzone, including zero itself", () => {
    expect(applyAxisDeadzone(0)).toBe(0);
    expect(applyAxisDeadzone(STICK_DEADZONE / 2)).toBe(0);
    expect(applyAxisDeadzone(-STICK_DEADZONE / 2)).toBe(0);
  });

  it("is continuous at the deadzone edge", () => {
    // Just inside -> 0, exactly at the edge -> 0, just outside -> tiny but > 0.
    expect(applyAxisDeadzone(STICK_DEADZONE)).toBe(0);
    const justOutside = applyAxisDeadzone(STICK_DEADZONE + 0.001);
    expect(justOutside).toBeGreaterThan(0);
    expect(justOutside).toBeLessThan(0.01);
  });

  it("preserves sign and maps full deflection to full output", () => {
    expect(applyAxisDeadzone(1)).toBe(1);
    expect(applyAxisDeadzone(-1)).toBe(-1);
    expect(applyAxisDeadzone(0.6)).toBeGreaterThan(0);
    expect(applyAxisDeadzone(-0.6)).toBeLessThan(0);
  });

  it("is monotonic past the deadzone", () => {
    const prev = applyAxisDeadzone(0.2);
    const mid = applyAxisDeadzone(0.5);
    const max = applyAxisDeadzone(1);
    expect(mid).toBeGreaterThan(prev);
    expect(max).toBeGreaterThan(mid);
  });
});

describe("applySensitivityCurve (precision near center)", () => {
  it("preserves sign and identity at the extremes", () => {
    expect(applySensitivityCurve(0)).toBe(0);
    expect(applySensitivityCurve(1)).toBe(1);
    expect(applySensitivityCurve(-1)).toBe(-1);
  });

  it("gives proportionally less output near the center (fine control travel)", () => {
    // 50% stick deflection -> ~42% input: extra travel where precision matters.
    expect(applySensitivityCurve(0.5)).toBeCloseTo(Math.pow(0.5, RESPONSE_POWER), 5);
    expect(applySensitivityCurve(0.5)).toBeLessThan(0.5);
    // The compression is deepest near the center; near full deflection the
    // output tracks the input closely (the ratio climbs back toward 1:1).
    expect(applySensitivityCurve(0.9)).toBeLessThan(0.9);
    const centerRatio = applySensitivityCurve(0.5) / 0.5;
    const edgeRatio = applySensitivityCurve(0.9) / 0.9;
    expect(edgeRatio).toBeGreaterThan(centerRatio);
  });

  it("is monotonic and never amplifies small inputs", () => {
    const half = applySensitivityCurve(0.5);
    const threeQuarter = applySensitivityCurve(0.75);
    expect(threeQuarter).toBeGreaterThan(half);
    expect(half).toBeLessThan(0.5);
    expect(Math.abs(applySensitivityCurve(0.1))).toBeLessThan(0.1);
  });
});

describe("shapeAnalogAxis", () => {
  it("composes deadzone + curve", () => {
    expect(shapeAnalogAxis(0)).toBe(0);
    expect(shapeAnalogAxis(STICK_DEADZONE)).toBe(0);
    expect(shapeAnalogAxis(1)).toBe(1);
    // 0.6 past the deadzone, then curved: between the raw value and 1.
    const shaped = shapeAnalogAxis(0.6);
    expect(shaped).toBeGreaterThan(0);
    expect(shaped).toBeLessThan(0.6);
  });
});

describe("gamepadSteerToVehicle", () => {
  it("inverts the browser's right-positive stick into the vehicle's left-positive steer", () => {
    expect(gamepadSteerToVehicle(1)).toBe(-1);
    expect(gamepadSteerToVehicle(-1)).toBe(1);
    expect(gamepadSteerToVehicle(0)).toBe(0);
    expect(gamepadSteerToVehicle(0.6)).toBeLessThan(0);
  });
});

describe("splitPedalAxis", () => {
  it("splits a -1..1 axis into independent throttle/brake", () => {
    expect(splitPedalAxis(0.7)).toEqual({ throttleTarget: 0.7, brakeTarget: 0 });
    expect(splitPedalAxis(-0.4)).toEqual({ throttleTarget: 0, brakeTarget: 0.4 });
    expect(splitPedalAxis(0)).toEqual({ throttleTarget: 0, brakeTarget: 0 });
  });
});

describe("readGamepadAxes", () => {
  it("maps the standard layout: stick steer, stick pedals, triggers add", () => {
    const input = readGamepadAxes({
      axes: [0.5, -0.25],
      buttons: [
        { value: 0, pressed: false, touched: false },
        { value: 0, pressed: false, touched: false },
        { value: 0, pressed: false, touched: false },
        { value: 0, pressed: false, touched: false },
        { value: 0, pressed: false, touched: false },
        { value: 0, pressed: false, touched: false },
        { value: 0.8, pressed: false, touched: false }, // index 6: left trigger (brake)
        { value: 1, pressed: false, touched: false }, // index 7: right trigger (throttle)
      ],
    });
    expect(input.steer).toBe(0.5);
    expect(input.pedalAxis).toBe(-0.25);
    expect(input.triggerThrottle).toBe(1);
    expect(input.triggerBrake).toBe(0.8);
  });

  it("tolerates pads with missing axes/buttons", () => {
    const input = readGamepadAxes({ axes: [], buttons: [] as GamepadButton[] });
    expect(input).toEqual({
      steer: 0,
      pedalAxis: 0,
      triggerThrottle: 0,
      triggerBrake: 0,
    });
  });
});

describe("engaged", () => {
  it("is false at and below the deadzone, true past it", () => {
    expect(engaged(0)).toBe(false);
    expect(engaged(STICK_DEADZONE)).toBe(false);
    expect(engaged(STICK_DEADZONE + 0.01)).toBe(true);
    expect(engaged(-STICK_DEADZONE - 0.01)).toBe(true);
    expect(engaged(1)).toBe(true);
  });
});