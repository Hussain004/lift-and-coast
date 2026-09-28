import { describe, expect, it } from "vitest";
import {
  CAMERA_MAX_YAW_LAG_RAD,
  fovForSpeed,
  shakeOffset,
  stepCameraYaw,
  wrapAngle,
} from "../lib/race/chaseCam";

describe("chase camera yaw spring", () => {
  it("has ZERO lag on a straight, at any speed - the galloping-bug guard", () => {
    // The position is carPos + rotate(offset, camYaw), so if camYaw equals the
    // car's yaw the offset is exact regardless of how fast the car moves.
    let cam = 0.4;
    for (let i = 0; i < 600; i++) cam = stepCameraYaw(cam, 0.4, 1 / 60);
    expect(Math.abs(cam - 0.4)).toBeLessThan(1e-9);
  });

  it("trails a turning car by a bounded, clamped angle", () => {
    let cam = 0;
    let car = 0;
    for (let i = 0; i < 120; i++) {
      car += 1.2 / 60; // a fast 1.2 rad/s rotation
      cam = stepCameraYaw(cam, car, 1 / 60);
    }
    const lag = car - cam;
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThanOrEqual(CAMERA_MAX_YAW_LAG_RAD + 1e-9);
  });

  it("clamps a teleport instead of swinging round", () => {
    const cam = stepCameraYaw(0, Math.PI * 0.9, 1 / 60);
    expect(Math.abs(wrapAngle(Math.PI * 0.9 - cam))).toBeCloseTo(CAMERA_MAX_YAW_LAG_RAD, 9);
  });

  it("takes the short way across the +-pi seam", () => {
    const cam = stepCameraYaw(Math.PI - 0.05, -Math.PI + 0.05, 1);
    expect(Math.abs(wrapAngle(cam - (-Math.PI + 0.05)))).toBeLessThan(0.01);
  });
});

describe("speed sensation", () => {
  it("widens the FOV only at speed, capped at the kick", () => {
    expect(fovForSpeed(65, 30)).toBe(65);
    expect(fovForSpeed(65, 350 / 3.6)).toBe(73);
    const mid = fovForSpeed(65, 240 / 3.6);
    expect(mid).toBeGreaterThan(65);
    expect(mid).toBeLessThan(73);
  });

  it("never shakes more than the ceiling", () => {
    for (let t = 0; t < 10; t += 0.013) {
      const s = shakeOffset(t, 1, 100);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(0.025);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(0.025);
    }
    const still = shakeOffset(1, 0, 0);
    expect(Math.abs(still.x) + Math.abs(still.y)).toBe(0);
  });
});
