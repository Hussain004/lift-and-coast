import { describe, expect, it } from "vitest";
import {
  SPRINT_LAPS,
  computeDriverStandings,
  createSeason,
  fastestLapPoint,
  isChampionshipSeason,
  isSprintRound,
  recordQualiResult,
  recordRoundResult,
  recordSprintResult,
  sprintPointsForPosition,
  weekendStage,
} from "../lib/race/championship";
import { classifyRace, createFinishTracker } from "../lib/race/classification";

const row = (code: string, position: number, points: number, isPlayer = false) => ({
  code,
  name: null,
  teamId: isPlayer ? "alpine" : "ferrari",
  position,
  points,
  isPlayer,
});

describe("weekend formats", () => {
  it("runs qualifying before the race on a full weekend, and skips it for race-only", () => {
    const full = createSeason(["monza", "spa"], "2026-01-01");
    expect(weekendStage(full, 0)).toBe("qualifying");
    expect(weekendStage(recordQualiResult(full, 0, 4), 0)).toBe("race");
    const raceOnly = createSeason(["monza", "spa"], "2026-01-01", { format: "race" });
    expect(weekendStage(raceOnly, 0)).toBe("race");
    expect(weekendStage(recordRoundResult(raceOnly, 0, 3), 0)).toBe("done");
  });

  it("keeps old saves as full weekends without sprints", () => {
    const season = createSeason(["monza"], "2026-01-01");
    expect(season.format).toBeUndefined();
    expect(season.sprints).toBeUndefined();
    expect(isChampionshipSeason(season)).toBe(true);
  });
});

describe("sprint weekends", () => {
  const ids = ["melbourne", "suzuka", "monaco", "silverstone", "spa", "monza"];

  it("makes every fourth round a sprint", () => {
    const s = createSeason(ids, "2026-01-01", { sprints: true });
    expect(ids.map((_, i) => isSprintRound(s, i))).toEqual([false, false, false, true, false, false]);
    expect(isSprintRound(createSeason(ids, "2026-01-01"), 3)).toBe(false);
  });

  it("puts a sprint between qualifying and the race until it is driven", () => {
    let s = createSeason(ids, "2026-01-01", { sprints: true });
    s = recordQualiResult(s, 3, 5);
    expect(weekendStage(s, 3)).toBe("sprint");
    s = recordSprintResult(s, 3, 2, [row("VER", 1, 8), row("GAS", 2, 7, true)]);
    expect(weekendStage(s, 3)).toBe("race");
    // A sprint on a non-sprint round is ignored.
    expect(recordSprintResult(s, 0, 1, [row("VER", 1, 8)])).toBe(s);
  });

  it("counts sprint points in the tables but not as wins or a race finish", () => {
    let s = createSeason(ids, "2026-01-01", { sprints: true });
    s = recordQualiResult(s, 3, 5);
    s = recordSprintResult(s, 3, 1, [row("GAS", 1, 8, true), row("VER", 2, 7)]);
    s = recordRoundResult(s, 3, 3, [row("VER", 1, 25), row("LEC", 2, 18), row("GAS", 3, 15, true)]);
    const table = computeDriverStandings(s);
    const you = table.find((d) => d.isPlayer)!;
    expect(you.points).toBe(23);
    expect(you.wins).toBe(0);
    expect(you.finishes[3]).toBe(3);
    expect(table.find((d) => d.code === "VER")!.points).toBe(32);
  });

  it("scores sprints 8-1 and rejects a malformed sprint on load", () => {
    expect([1, 2, 8, 9].map(sprintPointsForPosition)).toEqual([8, 7, 1, 0]);
    expect(SPRINT_LAPS).toBeGreaterThan(0);
    const s = createSeason(ids, "2026-01-01", { sprints: true });
    const bad = { ...s, rounds: s.rounds.map((r, i) => (i === 3 ? { ...r, sprint: { position: "x", result: [] } } : r)) };
    expect(isChampionshipSeason(bad)).toBe(false);
  });
});

describe("fastest lap point", () => {
  it("goes to the fastest lap only inside the top ten", () => {
    expect(fastestLapPoint(1, true)).toBe(1);
    expect(fastestLapPoint(10, true)).toBe(1);
    expect(fastestLapPoint(11, true)).toBe(0);
    expect(fastestLapPoint(1, false)).toBe(0);
  });

  it("adds it in the classification, and not for a sprint", () => {
    const entrants = ["A", "B", "C"].map((code, i) => ({
      code,
      name: null,
      teamId: null,
      color: "#fff",
      isPlayer: i === 0,
      laps: 3,
      livePosition: i + 1,
      bestLapSeconds: code === "B" ? 80 : 85,
      penaltySeconds: 0,
    }));
    const tracker = createFinishTracker(3);
    tracker.chequered = true;
    tracker.finishClock = [100, 101, 102];
    tracker.finishLaps = [3, 3, 3];
    const race = classifyRace(entrants, tracker);
    expect(race.map((r) => r.points)).toEqual([25, 19, 15]);
    expect(classifyRace(entrants, tracker, true).map((r) => r.points)).toEqual([8, 7, 6]);
  });
});
