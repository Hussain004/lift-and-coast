import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFFICULTY,
  DIFFICULTY_OPTIONS,
  difficultyAggressionShift,
  difficultyPaceScale,
  hashDriverCode,
  mulberry32,
  parseDifficulty,
  tireCurveMultiplier,
  traitsForDriver,
} from "../lib/ai/personalities";

describe("parseDifficulty", () => {
  it("accepts the four tiers, defaulting to Pro", () => {
    expect(parseDifficulty("rookie")).toBe("rookie");
    expect(parseDifficulty("club")).toBe("club");
    expect(parseDifficulty("pro")).toBe("pro");
    expect(parseDifficulty("ace")).toBe("ace");
    expect(parseDifficulty(null)).toBe(DEFAULT_DIFFICULTY);
    expect(parseDifficulty("legend")).toBe(DEFAULT_DIFFICULTY);
  });
});

describe("difficulty scales", () => {
  it("orders pace rookie < club < pro < ace", () => {
    const scales = (["rookie", "club", "pro", "ace"] as const).map(difficultyPaceScale);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(difficultyPaceScale("pro")).toBe(1);
  });

  it("keeps aggression shifts small and ordered", () => {
    expect(difficultyAggressionShift("rookie")).toBeLessThan(difficultyAggressionShift("club"));
    expect(difficultyAggressionShift("club")).toBeLessThan(difficultyAggressionShift("ace"));
  });
});

describe("traitsForDriver", () => {
  it("is deterministic per code and varies across the grid", () => {
    expect(traitsForDriver("VER")).toEqual(traitsForDriver("VER"));
    const codes = ["VER", "NOR", "LEC", "PIA", "RUS", "HAM", "ALO", "GAS"];
    const paces = codes.map((c) => traitsForDriver(c).pace);
    expect(new Set(paces).size).toBeGreaterThan(1);
    for (const pace of paces) {
      expect(pace).toBeGreaterThanOrEqual(0.985);
      expect(pace).toBeLessThanOrEqual(1.02);
    }
    const aggro = codes.map((c) => traitsForDriver(c).aggression);
    for (const a of aggro) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });

  it("covers the full 22-driver roster without collisions of character", () => {
    const codes = [
      "GAS", "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM", "LEC",
      "OCO", "BEA", "NOR", "PIA", "RUS", "ANT", "LAW", "LIN", "VER", "HAD",
      "SAI", "ALB",
    ];
    const seen = new Set(codes.map((c) => JSON.stringify(traitsForDriver(c))));
    // 22 drivers must not collapse onto a handful of identical characters.
    expect(seen.size).toBeGreaterThanOrEqual(20);
  });
});

describe("hashDriverCode", () => {
  it("is stable and spreads codes", () => {
    expect(hashDriverCode("VER")).toBe(hashDriverCode("VER"));
    expect(hashDriverCode("VER")).not.toBe(hashDriverCode("NOR"));
  });
});

describe("tireCurveMultiplier", () => {
  it("is neutral at ~35% distance and splits early/late drivers", () => {
    expect(tireCurveMultiplier(1, 0.35)).toBeCloseTo(1, 6);
    expect(tireCurveMultiplier(-1, 0.35)).toBeCloseTo(1, 6);
    expect(tireCurveMultiplier(1, 1)).toBeGreaterThan(tireCurveMultiplier(1, 0));
    expect(tireCurveMultiplier(-1, 1)).toBeLessThan(tireCurveMultiplier(-1, 0));
    // Sized to move races: opposite tire types swing ~2% across the distance.
    expect(tireCurveMultiplier(1, 1)).toBeLessThan(1.02);
    expect(tireCurveMultiplier(1, 1) - tireCurveMultiplier(-1, 1)).toBeGreaterThan(0.015);
  });

  it("clamps out-of-range progress", () => {
    expect(tireCurveMultiplier(1, 2)).toBe(tireCurveMultiplier(1, 1));
    expect(tireCurveMultiplier(1, -1)).toBe(tireCurveMultiplier(1, 0));
  });
});

describe("mulberry32", () => {
  it("reproduces its sequence per seed", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
  });
});

describe("DIFFICULTY_OPTIONS", () => {
  it("lists four labeled tiers", () => {
    expect(DIFFICULTY_OPTIONS.map((o) => o.id)).toEqual(["rookie", "club", "pro", "ace"]);
  });
});
