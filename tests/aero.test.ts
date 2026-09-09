import { describe, expect, it } from "vitest";
import { computeDownforceN } from "../lib/physics/aero";

describe("computeDownforceN", () => {
  it("is zero at a standstill", () => {
    expect(computeDownforceN(0)).toBe(0);
  });

  it("increases with speed", () => {
    expect(computeDownforceN(20)).toBeGreaterThan(computeDownforceN(10));
    expect(computeDownforceN(40)).toBeGreaterThan(computeDownforceN(20));
  });

  it("scales with the square of speed, not linearly", () => {
    const at10 = computeDownforceN(10);
    const at20 = computeDownforceN(20);
    // Doubling speed should roughly quadruple downforce (v^2 scaling).
    expect(at20 / at10).toBeCloseTo(4, 5);
  });

  it("is symmetric for negative speed (reversing)", () => {
    expect(computeDownforceN(-30)).toBe(computeDownforceN(30));
  });

  it("stays a modest fraction of a realistic car weight at realistic top speed", () => {
    const CAR_WEIGHT_N = 220 * 9.81;
    const downforceAtTopSpeed = computeDownforceN(45);
    expect(downforceAtTopSpeed).toBeGreaterThan(CAR_WEIGHT_N * 0.2);
    expect(downforceAtTopSpeed).toBeLessThan(CAR_WEIGHT_N * 0.7);
  });
});
