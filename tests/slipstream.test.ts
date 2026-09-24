import { describe, expect, it } from "vitest";
import { MAX_TOW_DRAG_REDUCTION, towDragScale } from "../lib/physics/aero";
import { createEnergySystem, overtakeModeActive } from "../lib/physics/energy";

// Heading yaw 0: forward is -Z, so a car "ahead" sits at negative z.
const own = { x: 0, z: 0, yawRad: 0, speedMs: 60 };

describe("slipstream", () => {
  it("is strongest right behind a car and gone by 40m", () => {
    const close = towDragScale(own, [{ x: 0, z: -4 }]);
    const mid = towDragScale(own, [{ x: 0, z: -20 }]);
    expect(close).toBeCloseTo(1 - MAX_TOW_DRAG_REDUCTION, 2);
    expect(mid).toBeGreaterThan(close);
    expect(mid).toBeLessThan(1);
    expect(towDragScale(own, [{ x: 0, z: -45 }])).toBe(1);
  });

  it("needs to be in the wake: not beside, behind, or slow", () => {
    expect(towDragScale(own, [{ x: 3, z: -10 }])).toBe(1);
    expect(towDragScale(own, [{ x: 0, z: 10 }])).toBe(1);
    expect(towDragScale({ ...own, speedMs: 15 }, [{ x: 0, z: -10 }])).toBe(1);
  });
});

describe("2026 overtake mode", () => {
  it("opens within one second of the car ahead at racing speed", () => {
    expect(overtakeModeActive(40, 60)).toBe(true);
    expect(overtakeModeActive(70, 60)).toBe(false);
    expect(overtakeModeActive(-5, 60)).toBe(false);
    expect(overtakeModeActive(5, 10)).toBe(false);
  });

  it("makes deployment cheaper, not stronger", () => {
    const plain = createEnergySystem();
    const override = createEnergySystem();
    let a = plain.update({ brakeAmount: 0, deployRequested: true }, 1);
    let b = override.update({ brakeAmount: 0, deployRequested: true, overrideActive: true }, 1);
    expect(b.engineForceMultiplier).toBe(a.engineForceMultiplier);
    expect(b.batteryFraction).toBeGreaterThan(a.batteryFraction);
    a = plain.update({ brakeAmount: 0, deployRequested: true }, 1);
    b = override.update({ brakeAmount: 0, deployRequested: true, overrideActive: true }, 1);
    expect(1 - b.batteryFraction).toBeCloseTo((1 - a.batteryFraction) * 0.4, 6);
  });
});
