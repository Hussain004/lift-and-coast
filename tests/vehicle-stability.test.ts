import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";

const TUNING = {
  engineForce: DEFAULT_ENGINE_FORCE,
  brakeForce: DEFAULT_BRAKE_FORCE,
  stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
};

// A flipped/tipped-over car has tilted roughly 90 degrees (pi/2) or more
// from upright. Stay well clear of that so this catches real instability,
// not just normal suspension lean.
const FLIP_THRESHOLD_RAD = 0.6;

describe("vehicle stability (headless)", () => {
  it("does not tip over holding full throttle for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 0 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
    // Guards against the car being technically stable but crawling - e.g.
    // linear damping large enough relative to engine force to cap speed at
    // a walking pace, which is exactly as undrivable as flipping.
    expect(result.distanceMeters).toBeGreaterThan(45);
    // currentVehicleSpeed()'s sign isn't a reliable direction indicator
    // (the real HUD already takes Math.abs() of it) - check magnitude.
    expect(Math.abs(result.finalSpeedMs)).toBeGreaterThan(10);
  }, 20000);

  it("does not tip over holding throttle and full steering lock for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 1 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  it("does not tip over holding the brake from a standstill", async () => {
    const result = await simulateDrive(
      3,
      { throttle: 0, brake: 1, steer: 0 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  it("does not tip over steering hard after building up speed", async () => {
    // The highest-lateral-load case a player hits: near top speed, then
    // full steering lock with no easing in.
    const result = await simulateDrive(
      25,
      (t) => ({ throttle: 1, brake: 0, steer: t > 20 ? 1 : 0 }),
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);
});
