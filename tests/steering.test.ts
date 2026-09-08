import { describe, expect, it } from "vitest";
import { stepSteering } from "../lib/input/steering";

describe("stepSteering", () => {
  it("moves toward a held target at the steering rate", () => {
    const result = stepSteering(0, 1, 0.1, 4, 6);
    expect(result).toBeCloseTo(0.4);
  });

  it("clamps to the target instead of overshooting", () => {
    const result = stepSteering(0.95, 1, 1, 4, 6);
    expect(result).toBe(1);
  });

  it("returns to center at the center rate when input is released", () => {
    const result = stepSteering(0.8, 0, 0.1, 4, 6);
    expect(result).toBeCloseTo(0.8 - 0.6);
  });

  it("snaps to zero instead of overshooting past center", () => {
    const result = stepSteering(0.1, 0, 1, 4, 6);
    expect(result).toBe(0);
  });
});
