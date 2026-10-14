import { describe, expect, it } from "vitest";
import { MILESTONES, computeStats, earnedMilestones, newlyEarned } from "../lib/race/driverStats";
import type { RaceHistoryRecord } from "../lib/race/raceHistory";

let n = 0;
const rec = (over: Partial<RaceHistoryRecord> = {}): RaceHistoryRecord => ({
  schemaVersion: 1,
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString(),
  trackId: "monza",
  laps: 3,
  rivals: 19,
  aiLevel: "pro",
  teamId: "alpine",
  driverCode: "GAS",
  finish: 5,
  points: 10,
  fastestLap: false,
  penaltySeconds: 0,
  disqualified: false,
  champRound: null,
  sprint: false,
  ...over,
});

describe("driver stats", () => {
  it("counts starts, wins, podiums, points and bests per circuit", () => {
    const s = computeStats([
      rec({ finish: 1, points: 25, fastestLap: true }),
      rec({ finish: 3, points: 15, trackId: "spa" }),
      rec({ finish: 9, points: 2, trackId: "spa" }),
      rec({ finish: 12, points: 0 }),
    ]);
    expect(s).toMatchObject({ starts: 4, wins: 1, podiums: 2, pointsFinishes: 3, fastestLaps: 1, points: 42, circuitsRaced: 2 });
    expect(s.bestByTrack).toEqual({ monza: 1, spa: 3 });
  });

  it("does not credit a disqualified race with a result", () => {
    const s = computeStats([rec({ finish: 1, disqualified: true, points: 25 })]);
    expect(s).toMatchObject({ starts: 1, wins: 0, points: 0 });
  });
});

describe("milestones", () => {
  it("has unique ids", () => {
    expect(new Set(MILESTONES.map((m) => m.id)).size).toBe(MILESTONES.length);
  });

  it("is empty with no races and grows with results", () => {
    expect(earnedMilestones([]).size).toBe(0);
    const ids = earnedMilestones([rec({ finish: 1, fastestLap: true })]);
    for (const id of ["first-start", "first-points", "first-podium", "first-win", "fastest-lap", "full-grid-win", "clean-race"]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(ids.has("ace-win")).toBe(false);
  });

  it("needs three wins in a row for the hat-trick, in time order", () => {
    const w = (i: number) => rec({ finish: 1, at: new Date(Date.UTC(2026, 5, i)).toISOString() });
    const lose = rec({ finish: 4, at: new Date(Date.UTC(2026, 5, 2, 12)).toISOString() });
    expect(earnedMilestones([w(1), w(2), w(3)]).has("hat-trick")).toBe(true);
    expect(earnedMilestones([w(1), w(2), lose, w(3)]).has("hat-trick")).toBe(false);
  });

  it("circuit milestones count distinct tracks", () => {
    const tracks = ["a", "b", "c", "d", "e"].map((t) => rec({ finish: 2, trackId: t }));
    expect(earnedMilestones(tracks).has("podium-tour")).toBe(true);
    expect(earnedMilestones(tracks.slice(0, 4)).has("podium-tour")).toBe(false);
  });

  it("newlyEarned reports only what the latest race unlocked", () => {
    const first = rec({ finish: 4 });
    const second = rec({ finish: 1 });
    const unlocked = newlyEarned([first], second).map((m) => m.id);
    expect(unlocked).toContain("first-win");
    expect(unlocked).toContain("first-podium");
    expect(unlocked).not.toContain("first-start");
  });
});
