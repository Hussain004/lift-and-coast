import { describe, expect, it } from "vitest";
import { createSchool, currentDrill, schoolProgress, stepSchool, type SchoolInput } from "../lib/race/drivingSchool";

const inp = (over: Partial<SchoolInput> = {}): SchoolInput => ({
  speedKmh: 0,
  brake: 0,
  steer: 0,
  overtakeActive: false,
  lap: 1,
  lapInvalid: false,
  ...over,
});

describe("driving school", () => {
  it("runs the drills in order", () => {
    const s = createSchool();
    expect(currentDrill(s)?.id).toBe("launch");
    expect(stepSchool(s, inp({ speedKmh: 150 }))).toBeNull();
    expect(stepSchool(s, inp({ speedKmh: 205 }))?.id).toBe("launch");
    expect(currentDrill(s)?.id).toBe("brake");
  });

  it("needs a real braking zone: brake pressed, no hard steering, below 80", () => {
    const s = createSchool();
    stepSchool(s, inp({ speedKmh: 210 }));
    // Coasting down without the brake does not count.
    expect(stepSchool(s, inp({ speedKmh: 70 }))).toBeNull();
    stepSchool(s, inp({ speedKmh: 200, brake: 0 })); // back up to speed, fresh attempt
    stepSchool(s, inp({ speedKmh: 190, brake: 0.8, steer: 0.9 })); // steered hard: attempt spoiled
    expect(stepSchool(s, inp({ speedKmh: 60, brake: 0.8 }))).toBeNull();
    stepSchool(s, inp({ speedKmh: 200, brake: 0 })); // fresh attempt
    stepSchool(s, inp({ speedKmh: 150, brake: 0.9 }));
    expect(stepSchool(s, inp({ speedKmh: 60, brake: 0.9 }))?.id).toBe("brake");
  });

  it("completes overtake then needs a lap with no limits broken", () => {
    const s = createSchool();
    s.done.launch = true;
    s.done.brake = true;
    expect(stepSchool(s, inp({ overtakeActive: true }))?.id).toBe("overtake");
    stepSchool(s, inp({ lap: 1 }));
    stepSchool(s, inp({ lap: 1, lapInvalid: true }));
    expect(stepSchool(s, inp({ lap: 2 }))).toBeNull(); // that lap was invalid; counting restarts
    expect(stepSchool(s, inp({ lap: 2 }))).toBeNull();
    expect(stepSchool(s, inp({ lap: 3 }))?.id).toBe("lap");
    expect(currentDrill(s)).toBeNull();
    expect(schoolProgress(s)).toEqual({ done: 4, total: 4 });
  });
});
