import { describe, expect, it } from "vitest";
import {
  computeSignedForwardSpeed,
  speedSensitiveSteerScale,
  tractionControlThrottleScale,
} from "../lib/physics/vehicle";
import { computeDownforceN, computeDragN } from "../lib/physics/aero";
import { rpmForGear } from "../lib/physics/gearbox";

/**
 * Rapier's controller.currentVehicleSpeed() intermittently reports the wrong
 * SIGN at sustained high speed while its magnitude stays correct (see
 * computeSignedForwardSpeed's own comment). Car.tsx deliberately keeps
 * reading that raw value on the player's control path and relies on every
 * consumer being sign-insensitive - so this suite guards that property. If a
 * future refactor drops a Math.abs() (or squares something that was
 * linear), these tests fail loudly instead of silently feeding a negative
 * "speed" into steering, traction control, the gearbox or downforce.
 */
describe("player control-path speed shaping is sign-insensitive", () => {
  it("steer scaling treats forward and reverse speed identically", () => {
    for (const speed of [0, 4, 8, 20, 45, 90]) {
      expect(speedSensitiveSteerScale(-speed)).toBe(speedSensitiveSteerScale(speed));
    }
  });

  it("traction control treats forward and reverse speed identically", () => {
    for (const speed of [0, 7, 15, 40, 80]) {
      expect(tractionControlThrottleScale(-speed, 0.5, true)).toBe(
        tractionControlThrottleScale(speed, 0.5, true)
      );
    }
  });

  it("rpm (and therefore auto-shifting) ignores the speed's sign", () => {
    for (const gear of [1, 4, 7]) {
      expect(rpmForGear(-60, gear)).toBe(rpmForGear(60, gear));
    }
  });

  it("downforce and drag ignore the speed's sign", () => {
    expect(computeDownforceN(-70)).toBe(computeDownforceN(70));
    expect(computeDownforceN(-70, "low-drag")).toBe(computeDownforceN(70, "low-drag"));
    expect(computeDragN(-70)).toBe(computeDragN(70));
    expect(computeDragN(-70, "low-drag")).toBe(computeDragN(70, "low-drag"));
  });
});

describe("computeSignedForwardSpeed", () => {
  it("is positive driving forward (forward is -Z at yaw 0)", () => {
    expect(computeSignedForwardSpeed({ x: 0, z: -30 }, 0)).toBeCloseTo(30, 10);
  });

  it("is negative reversing", () => {
    expect(computeSignedForwardSpeed({ x: 0, z: 30 }, 0)).toBeCloseTo(-30, 10);
  });

  it("ignores purely lateral velocity", () => {
    expect(computeSignedForwardSpeed({ x: 25, z: 0 }, 0)).toBeCloseTo(0, 10);
  });

  it("follows the heading", () => {
    // yaw +90deg turns forward to -X.
    expect(computeSignedForwardSpeed({ x: -20, z: 0 }, Math.PI / 2)).toBeCloseTo(20, 10);
  });
});
