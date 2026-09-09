import { describe, expect, it } from "vitest";
import { computeWheelLoads, type VehicleGeometry } from "../lib/physics/weightTransfer";

// Matches the real car: wheelbase from CAR_WHEELS z=+-1.3, track width from
// x=+-0.82, cgHeight measured empirically by settling the real chassis
// (Rapier RigidBody + vehicle controller) on flat ground and reading
// chassis.translation().y once suspension load settles (~0.79m - high
// relative to the 1.64m track width, which is exactly why this car was so
// rollover-prone before the stance fixes earlier in the project).
const GEOMETRY: VehicleGeometry = {
  massKg: 225.76,
  wheelbaseM: 2.6,
  trackWidthM: 1.64,
  cgHeightM: 0.792,
  frontWeightBias: 0.5,
};

const TOTAL_WEIGHT_N = GEOMETRY.massKg * 9.81;

function sumLoads(loads: ReturnType<typeof computeWheelLoads>): number {
  return loads.frontLeft + loads.frontRight + loads.rearLeft + loads.rearRight;
}

describe("computeWheelLoads", () => {
  it("distributes static weight evenly at zero acceleration with a 50/50 bias", () => {
    const loads = computeWheelLoads(GEOMETRY, 0, 0);
    const each = TOTAL_WEIGHT_N / 4;
    expect(loads.frontLeft).toBeCloseTo(each, 5);
    expect(loads.frontRight).toBeCloseTo(each, 5);
    expect(loads.rearLeft).toBeCloseTo(each, 5);
    expect(loads.rearRight).toBeCloseTo(each, 5);
  });

  it("respects a non-50/50 static weight bias at zero acceleration", () => {
    const loads = computeWheelLoads({ ...GEOMETRY, frontWeightBias: 0.45 }, 0, 0);
    expect(loads.frontLeft + loads.frontRight).toBeCloseTo(TOTAL_WEIGHT_N * 0.45, 5);
    expect(loads.rearLeft + loads.rearRight).toBeCloseTo(TOTAL_WEIGHT_N * 0.55, 5);
  });

  it("conserves total load under moderate (non-clamping) acceleration", () => {
    const scenarios: [number, number][] = [
      [3, 0],
      [-4, 0],
      [0, 3],
      [2, -2],
    ];
    for (const [longAccel, latAccel] of scenarios) {
      const loads = computeWheelLoads(GEOMETRY, longAccel, latAccel);
      expect(sumLoads(loads)).toBeCloseTo(TOTAL_WEIGHT_N, 5);
    }
  });

  it("shifts load to the rear under forward acceleration", () => {
    const loads = computeWheelLoads(GEOMETRY, 4, 0);
    expect(loads.rearLeft + loads.rearRight).toBeGreaterThan(loads.frontLeft + loads.frontRight);
  });

  it("shifts load to the front under braking", () => {
    const loads = computeWheelLoads(GEOMETRY, -4, 0);
    expect(loads.frontLeft + loads.frontRight).toBeGreaterThan(loads.rearLeft + loads.rearRight);
  });

  it("shifts load to the right-side wheels under positive lateral acceleration", () => {
    const loads = computeWheelLoads(GEOMETRY, 0, 4);
    expect(loads.frontRight).toBeGreaterThan(loads.frontLeft);
    expect(loads.rearRight).toBeGreaterThan(loads.rearLeft);
  });

  it("clamps a wheel's load at zero instead of going negative under extreme transfer", () => {
    const loads = computeWheelLoads(GEOMETRY, 0, 50);
    expect(loads.frontLeft).toBe(0);
    expect(loads.rearLeft).toBe(0);
    expect(loads.frontRight).toBeGreaterThan(0);
  });
});
