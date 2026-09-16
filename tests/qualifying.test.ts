import { describe, expect, it } from "vitest";
import { createQualifyingTimes, polePosition } from "../lib/race/qualifying";

describe("polePosition", () => {
  it("is null until both sides have a time", () => {
    expect(polePosition(createQualifyingTimes())).toBeNull();
    expect(polePosition({ player: 90, ai: null })).toBeNull();
    expect(polePosition({ player: null, ai: 90 })).toBeNull();
  });

  it("picks whichever side is faster once both are in", () => {
    expect(polePosition({ player: 88, ai: 90 })).toBe("player");
    expect(polePosition({ player: 92, ai: 90 })).toBe("ai");
  });

  it("breaks an exact tie in favor of the player, matching computeRacePosition", () => {
    expect(polePosition({ player: 90, ai: 90 })).toBe("player");
  });
});
