import { describe, expect, it } from "vitest";
import { createWeatherPlan, forecastLabel, nextWeatherChange, planPresetAt } from "../lib/physics/weatherForecast";

describe("weather forecast", () => {
  it("is deterministic per seed and differs between seeds", () => {
    expect(createWeatherPlan(4)).toEqual(createWeatherPlan(4));
    const many = new Set(Array.from({ length: 12 }, (_, i) => JSON.stringify(createWeatherPlan(i))));
    expect(many.size).toBeGreaterThan(4);
  });

  it("holds a settled opening, then rain, then eases off", () => {
    for (let seed = 0; seed < 30; seed++) {
      const plan = createWeatherPlan(seed);
      expect(plan.changes[0].preset).toBe("rain");
      expect(plan.changes[0].atSeconds).toBeGreaterThanOrEqual(75);
      expect(plan.changes[1].atSeconds).toBeGreaterThan(plan.changes[0].atSeconds + 100);
      expect(planPresetAt(plan, 0)).toBe(plan.start);
      expect(planPresetAt(plan, plan.changes[0].atSeconds + 1)).toBe("rain");
      expect(planPresetAt(plan, plan.changes[1].atSeconds + 1)).toBe("cloudy");
    }
  });

  it("counts down to the next change and labels it", () => {
    const plan = { start: "clear" as const, changes: [{ atSeconds: 130, preset: "rain" as const }] };
    expect(nextWeatherChange(plan, 10)).toEqual({ inSeconds: 120, preset: "rain" });
    expect(forecastLabel(nextWeatherChange(plan, 10))).toBe("RAIN IN 2:00");
    expect(nextWeatherChange(plan, 131)).toBeNull();
    expect(forecastLabel(null)).toBeNull();
  });
});
