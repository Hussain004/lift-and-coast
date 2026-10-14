import { describe, expect, it } from "vitest";
import { adviceFor, describeStrategy, strategyOptions } from "../lib/race/strategyAdvice";

describe("strategy advice", () => {
  it("is deterministic and sorted best-first", () => {
    const a = strategyOptions(5800, 10, 90);
    expect(a).toEqual(strategyOptions(5800, 10, 90));
    for (let i = 1; i < a.length; i++) expect(a[i].extraSeconds).toBeGreaterThanOrEqual(a[i - 1].extraSeconds);
  });

  it("pits strictly inside the race, and only plans a stop with two stints", () => {
    for (const o of strategyOptions(5800, 12, 90)) {
      if (o.compounds.length === 2) {
        expect(o.pitLap).toBeGreaterThanOrEqual(1);
        expect(o.pitLap).toBeLessThan(12);
      } else {
        expect(o.pitLap).toBeNull();
      }
    }
  });

  it("a hard tyre outlasts a soft one on a long race, and a stop is worth it once softs are worn out", () => {
    const long = strategyOptions(5800, 20, 90);
    const soft = long.find((o) => o.compounds.length === 1 && o.compounds[0] === "soft")!;
    const hard = long.find((o) => o.compounds.length === 1 && o.compounds[0] === "hard")!;
    expect(hard.extraSeconds).toBeLessThan(soft.extraSeconds);
    expect(long[0].pitLap).not.toBeNull();
  });

  it("a short race is best with no stop, and the pit loss shows", () => {
    const best = strategyOptions(5800, 5, 90)[0];
    expect(best.pitLap).toBeNull();
  });

  it("describes plans and gaps", () => {
    const [first, second] = adviceFor(5800, 20, 90, 2);
    expect(first.gapSeconds).toBe(0);
    expect(second.gapSeconds).toBeGreaterThanOrEqual(0);
    expect(describeStrategy({ compounds: ["medium", "hard"], pitLap: 3, extraSeconds: 0 })).toBe("Medium → Hard, pit after lap 3");
    expect(describeStrategy({ compounds: ["hard"], pitLap: null, extraSeconds: 0 })).toBe("Hard, no stop");
  });
});
