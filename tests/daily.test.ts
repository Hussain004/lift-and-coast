import { describe, expect, it } from "vitest";
import { dailyChallenge, dailyKey, dailyStatus, dailyStreak, medalFor } from "../lib/race/daily";
import type { RaceHistoryRecord } from "../lib/race/raceHistory";
import { buildRaceUrl } from "../lib/race/sessionSetup";

const tracks = ["a", "b", "c", "d", "e", "f", "g"];
const rec = (daily: string | undefined, finish: number, dsq = false): RaceHistoryRecord => ({
  schemaVersion: 1,
  at: `${daily ?? "2026-01-01"}T10:00:00.000Z`,
  trackId: "a",
  laps: 3,
  rivals: 19,
  aiLevel: "pro",
  teamId: "t",
  driverCode: "X",
  finish,
  points: 0,
  fastestLap: false,
  penaltySeconds: 0,
  disqualified: dsq,
  champRound: null,
  sprint: false,
  daily,
});

describe("daily challenge", () => {
  it("is the same all day and varies from day to day", () => {
    const d = new Date("2026-10-14T23:59:59Z");
    expect(dailyKey(d)).toBe("2026-10-14");
    expect(dailyChallenge("2026-10-14", tracks)).toEqual(dailyChallenge("2026-10-14", tracks));
    const picks = new Set(
      Array.from({ length: 30 }, (_, i) => dailyChallenge(`2026-11-${String(i + 1).padStart(2, "0")}`, tracks).trackId)
    );
    expect(picks.size).toBeGreaterThan(3);
  });

  it("awards medals by finishing position", () => {
    expect(medalFor(1)).toBe("gold");
    expect(medalFor(5)).toBe("silver");
    expect(medalFor(10)).toBe("bronze");
    expect(medalFor(11)).toBeNull();
    expect(medalFor(1, true)).toBeNull();
  });

  it("reports the best medal and attempts for a day", () => {
    const h = [rec("2026-10-14", 8), rec("2026-10-14", 3), rec("2026-10-13", 1), rec(undefined, 1)];
    expect(dailyStatus(h, "2026-10-14")).toEqual({ attempts: 2, best: "silver" });
    expect(dailyStatus(h, "2026-10-12")).toEqual({ attempts: 0, best: null });
  });

  it("counts the streak back from today, or yesterday if today is not played yet", () => {
    const h = [rec("2026-10-14", 9), rec("2026-10-13", 9), rec("2026-10-12", 9), rec("2026-10-10", 9)];
    expect(dailyStreak(h, "2026-10-14")).toBe(3);
    expect(dailyStreak(h, "2026-10-15")).toBe(3);
    expect(dailyStreak(h, "2026-10-16")).toBe(0);
    expect(dailyStreak(h, "")).toBe(0);
    expect(dailyStreak([rec("2026-02-28", 5), rec("2026-03-01", 5)], "2026-03-01")).toBe(2);
  });

  it("carries the day on the race URL", () => {
    expect(buildRaceUrl({ track: "monza", daily: "2026-10-14" })).toContain("daily=2026-10-14");
  });
});
