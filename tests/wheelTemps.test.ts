import { describe, expect, it } from "vitest";
import { createWheelTemps, stepWheelTemps, wheelHeat } from "../lib/race/wheelTemps";

const settle = (input: { latG: number; brake01: number; throttle01: number }) => {
  const t = createWheelTemps(90);
  for (let i = 0; i < 600; i++) stepWheelTemps(t, 90, { ...input, dt: 0.1 });
  return t;
};

describe("wheel temperatures", () => {
  it("stays uniform on a plain straight", () => {
    expect(settle({ latG: 0, brake01: 0, throttle01: 0 })).toEqual([90, 90, 90, 90]);
  });
  it("heats the outside pair in a corner", () => {
    const left = settle({ latG: 3, brake01: 0, throttle01: 0 }); // turning left
    expect(left[1]).toBeGreaterThan(left[0] + 10);
    expect(left[3]).toBeGreaterThan(left[2] + 10);
    const right = settle({ latG: -3, brake01: 0, throttle01: 0 });
    expect(right[0]).toBeGreaterThan(right[1] + 10);
  });
  it("heats the fronts under braking and the rears under power", () => {
    const braking = settle({ latG: 0, brake01: 1, throttle01: 0 });
    expect(braking[0]).toBeGreaterThan(braking[2]);
    const power = settle({ latG: 0, brake01: 0, throttle01: 1 });
    expect(power[2]).toBeGreaterThan(power[0]);
  });
  it("moves gradually, not in a step", () => {
    const t = createWheelTemps(90);
    stepWheelTemps(t, 90, { latG: 3, brake01: 0, throttle01: 0, dt: 1 / 60 });
    expect(t[1] - 90).toBeLessThan(0.5);
  });
  it("classifies against the mean", () => {
    expect(wheelHeat(97, 90)).toBe("hot");
    expect(wheelHeat(83, 90)).toBe("cool");
    expect(wheelHeat(91, 90)).toBe("ok");
  });
});
