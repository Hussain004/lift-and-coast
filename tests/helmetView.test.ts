import { describe, expect, it } from "vitest";
import {
  HELMET_EYE_Y,
  HELMET_EYE_Z,
  HELMET_FOV_DEG,
  STEERING_WHEEL_CENTER_Y,
  STEERING_WHEEL_CENTER_Z,
  helmetAimPitchDeg,
  helmetHorizontalHalfFovDeg,
  helmetSideTrimInFrame,
  helmetVerticalHalfFovDeg,
  helmetWheelFraming,
} from "../lib/race/helmetView";

describe("helmet camera framing", () => {
  it("keeps the driver's eye inside the sculpted helmet shell", () => {
    // carSculpt.ts puts the helmet sphere at (0, 0.42, 0.3) with r=0.16.
    const dy = HELMET_EYE_Y - 0.42;
    const dz = HELMET_EYE_Z - 0.3;
    expect(Math.hypot(dy, dz)).toBeLessThan(0.16);
  });

  it("has a slight down-tilt and a wide field of view", () => {
    expect(helmetAimPitchDeg()).toBeGreaterThan(0);
    expect(helmetAimPitchDeg()).toBeLessThan(5);
    expect(helmetVerticalHalfFovDeg()).toBe(HELMET_FOV_DEG / 2);
    expect(helmetHorizontalHalfFovDeg(16 / 9)).toBeGreaterThan(45);
  });

  it("puts the whole steering wheel in frame in the lower half", () => {
    const framing = helmetWheelFraming();
    expect(framing.wheelFullyVisible).toBe(true);
    expect(framing.wheelCenterBelowAxisDeg).toBeGreaterThan(0);
    expect(framing.wheelCenterBelowAxisDeg).toBeLessThan(framing.verticalHalfFovDeg);
    expect(framing.wheelBottomBelowAxisDeg).toBeLessThan(framing.verticalHalfFovDeg);
    expect(framing.wheelTopBelowAxisDeg).toBeGreaterThan(0);
  });

  it("widens the horizontal field on wide viewports", () => {
    expect(helmetHorizontalHalfFovDeg(2.1)).toBeGreaterThan(
      helmetHorizontalHalfFovDeg(1.6)
    );
    expect(helmetHorizontalHalfFovDeg(0.6)).toBeLessThan(
      helmetHorizontalHalfFovDeg(1.6)
    );
  });

  it("keeps the car's own side trim (mirror housings) in shot", () => {
    expect(helmetSideTrimInFrame(16 / 9)).toBe(true);
    expect(helmetSideTrimInFrame(2.1)).toBe(true);
  });

  it("keeps the wheel ahead of the eye so it is never behind the camera", () => {
    expect(STEERING_WHEEL_CENTER_Z).toBeLessThan(HELMET_EYE_Z);
    expect(STEERING_WHEEL_CENTER_Y).toBeLessThan(HELMET_EYE_Y);
  });
});
