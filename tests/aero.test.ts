import { describe, expect, it } from "vitest";
import { computeDownforceN, computeDragN } from "../lib/physics/aero";

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

  it("defaults to high-downforce mode, unaffected by aero mode toggling", () => {
    expect(computeDownforceN(30, "high-downforce")).toBe(computeDownforceN(30));
  });

  it("low-drag mode reduces downforce relative to high-downforce mode", () => {
    expect(computeDownforceN(30, "low-drag")).toBeLessThan(computeDownforceN(30, "high-downforce"));
  });
});

describe("computeDragN", () => {
  it("is zero at a standstill", () => {
    expect(computeDragN(0)).toBe(0);
  });

  it("scales with the square of speed", () => {
    const at10 = computeDragN(10);
    const at20 = computeDragN(20);
    expect(at20 / at10).toBeCloseTo(4, 5);
  });

  it("stays a minor fraction of engine force in the tuned speed range", () => {
    // At ~14.7 m/s (the harness's own straight-throttle result at default
    // tuning), drag should not meaningfully fight acceleration.
    const ENGINE_FORCE_N = 500;
    expect(computeDragN(14.7)).toBeLessThan(ENGINE_FORCE_N * 0.15);
  });

  it("low-drag mode reduces drag relative to high-downforce mode", () => {
    expect(computeDragN(30, "low-drag")).toBeLessThan(computeDragN(30, "high-downforce"));
  });

  it("defaults to high-downforce mode", () => {
    expect(computeDragN(30)).toBe(computeDragN(30, "high-downforce"));
  });
});
