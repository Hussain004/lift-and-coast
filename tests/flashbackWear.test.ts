import { describe, expect, it } from "vitest";
import { createStrategySystem } from "../lib/race/strategy";

const step = { dt: 1 / 60, speedMs: 60, throttle: 1, brake: 0, progressMeters: 500, trackLengthMeters: 5000, racing: true, lap: 1 };

function drive(strategy: ReturnType<typeof createStrategySystem>, seconds: number) {
  for (let i = 0; i < seconds * 60; i++) strategy.update(step);
}

describe("flashback gives tyre life back", () => {
  it("restores tyre age, temperature and fuel to the saved moment", () => {
    const s = createStrategySystem();
    drive(s, 5);
    const saved = {
      compound: s.state.compound,
      pitStops: s.state.pitStops,
      tireAgeMeters: s.state.tireAgeMeters,
      tireTemperatureC: s.state.tireTemperatureC,
      fuelKg: s.state.fuelKg,
    };
    drive(s, 10);
    expect(s.state.tireAgeMeters).toBeGreaterThan(saved.tireAgeMeters);
    expect(s.restoreWear(saved)).toBe(true);
    expect(s.state.tireAgeMeters).toBe(saved.tireAgeMeters);
    expect(s.state.fuelKg).toBe(saved.fuelKg);
  });

  it("does not restore wear from before a tyre change", () => {
    const s = createStrategySystem();
    drive(s, 5);
    const saved = {
      compound: s.state.compound,
      pitStops: s.state.pitStops,
      tireAgeMeters: s.state.tireAgeMeters,
      tireTemperatureC: s.state.tireTemperatureC,
      fuelKg: s.state.fuelKg,
    };
    s.setCompound("soft");
    drive(s, 1);
    const age = s.state.tireAgeMeters;
    expect(s.restoreWear(saved)).toBe(false);
    expect(s.state.tireAgeMeters).toBe(age);
  });
});
