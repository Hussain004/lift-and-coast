import { describe, expect, it } from "vitest";
import { computeTireForces, loadSensitivityScale } from "../lib/physics/tireModel";

const NOMINAL_LOAD_N = 2000;

describe("computeTireForces", () => {
  it("produces zero force at zero slip", () => {
    const forces = computeTireForces({
      slipAngleRad: 0,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    });
    expect(forces.lateralForceN).toBe(0);
    expect(forces.longitudinalForceN).toBe(0);
  });

  it("produces zero force at zero load", () => {
    const forces = computeTireForces({
      slipAngleRad: 0.1,
      slipRatio: 0.1,
      normalLoadN: 0,
      compoundGrip: 1,
    });
    expect(forces.lateralForceN).toBe(0);
    expect(forces.longitudinalForceN).toBe(0);
  });

  it("rises to a peak then falls off as slip angle increases", () => {
    const at = (slipAngleRad: number) =>
      computeTireForces({ slipAngleRad, slipRatio: 0, normalLoadN: NOMINAL_LOAD_N, compoundGrip: 1 })
        .lateralForceN;

    const nearPeak = at(0.16);
    const wellPast = at(1.5);
    const small = at(0.02);

    expect(nearPeak).toBeGreaterThan(small);
    expect(nearPeak).toBeGreaterThan(wellPast);
  });

  it("gives an opposing force of the same magnitude for opposite-signed slip", () => {
    const positive = computeTireForces({
      slipAngleRad: 0.1,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    });
    const negative = computeTireForces({
      slipAngleRad: -0.1,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    });
    expect(negative.lateralForceN).toBeCloseTo(-positive.lateralForceN, 6);
  });

  it("scales force proportionally with compound grip", () => {
    const base = computeTireForces({
      slipAngleRad: 0.1,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    });
    const softer = computeTireForces({
      slipAngleRad: 0.1,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1.2,
    });
    expect(softer.lateralForceN).toBeCloseTo(base.lateralForceN * 1.2, 6);
  });

  it("increases peak force sub-linearly with load", () => {
    const peakAt = (normalLoadN: number) =>
      computeTireForces({
        slipAngleRad: 0.16, // at the peak slip angle
        slipRatio: 0,
        normalLoadN,
        compoundGrip: 1,
      }).lateralForceN;

    const atReference = peakAt(NOMINAL_LOAD_N);
    const atDouble = peakAt(NOMINAL_LOAD_N * 2);

    expect(atDouble).toBeGreaterThan(atReference);
    // Sub-linear: doubling load must not double the force.
    expect(atDouble).toBeLessThan(atReference * 2);
  });

  it("clamps combined force to the friction circle", () => {
    const forces = computeTireForces({
      slipAngleRad: 0.16, // both near their own individual peak
      slipRatio: 0.12,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    });
    const maxAlone = computeTireForces({
      slipAngleRad: 0.16,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    }).lateralForceN;

    const combinedMagnitude = Math.hypot(forces.lateralForceN, forces.longitudinalForceN);
    expect(combinedMagnitude).toBeLessThanOrEqual(maxAlone + 1e-6);
  });

  it("keeps combined force within the circle across many random slip pairs", () => {
    const maxAlone = computeTireForces({
      slipAngleRad: 0.16,
      slipRatio: 0,
      normalLoadN: NOMINAL_LOAD_N,
      compoundGrip: 1,
    }).lateralForceN;

    for (let i = 0; i < 200; i++) {
      const slipAngleRad = (Math.random() - 0.5) * 4;
      const slipRatio = (Math.random() - 0.5) * 4;
      const forces = computeTireForces({
        slipAngleRad,
        slipRatio,
        normalLoadN: NOMINAL_LOAD_N,
        compoundGrip: 1,
      });
      const magnitude = Math.hypot(forces.lateralForceN, forces.longitudinalForceN);
      expect(magnitude).toBeLessThanOrEqual(maxAlone + 1e-6);
    }
  });
});

describe("loadSensitivityScale", () => {
  const REFERENCE_LOAD_N = 540;

  it("returns 1 at the reference load", () => {
    expect(loadSensitivityScale(REFERENCE_LOAD_N, REFERENCE_LOAD_N)).toBeCloseTo(1, 6);
  });

  it("returns less than 1 above the reference load and more than 1 below it", () => {
    expect(loadSensitivityScale(REFERENCE_LOAD_N * 2, REFERENCE_LOAD_N)).toBeLessThan(1);
    expect(loadSensitivityScale(REFERENCE_LOAD_N * 0.5, REFERENCE_LOAD_N)).toBeGreaterThan(1);
  });

  it("is monotonically decreasing as load increases", () => {
    const loads = [100, 300, 540, 1000, 2000, 5000];
    const scales = loads.map((l) => loadSensitivityScale(l, REFERENCE_LOAD_N));
    for (let i = 1; i < scales.length; i++) {
      expect(scales[i]).toBeLessThan(scales[i - 1]);
    }
  });

  it("clamps to a bounded range even at extreme loads", () => {
    const atZero = loadSensitivityScale(0, REFERENCE_LOAD_N);
    const atTiny = loadSensitivityScale(0.001, REFERENCE_LOAD_N);
    const atHuge = loadSensitivityScale(1_000_000, REFERENCE_LOAD_N);
    expect(atZero).toBeLessThanOrEqual(1.5);
    expect(atTiny).toBeLessThanOrEqual(1.5);
    expect(atHuge).toBeGreaterThanOrEqual(0.6);
  });
});
