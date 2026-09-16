import { describe, expect, it } from "vitest";
import {
  CHAMPIONSHIP_POINTS,
  computeStandings,
  createSeason,
  isChampionshipSeason,
  isSeasonComplete,
  nextRoundIndex,
  parseChampRound,
  pointsForPosition,
  recordRoundResult,
  seasonChampion,
  totalRounds,
  type ChampionshipSeason,
} from "../lib/race/championship";

const TRACK_IDS = ["silverstone", "monza", "spa", "suzuka"];

describe("pointsForPosition", () => {
  it("matches the F1-style table", () => {
    expect(CHAMPIONSHIP_POINTS[0]).toBe(25);
    expect(pointsForPosition(1)).toBe(25);
    expect(pointsForPosition(2)).toBe(18);
    expect(pointsForPosition(3)).toBe(15);
    expect(pointsForPosition(10)).toBe(1);
  });

  it("scores nothing for an invalid position", () => {
    expect(pointsForPosition(0)).toBe(0);
    expect(pointsForPosition(-1)).toBe(0);
    expect(pointsForPosition(11)).toBe(0);
    expect(pointsForPosition(2.5)).toBe(0);
  });
});

describe("createSeason", () => {
  it("creates one un-raced round per track, in order", () => {
    const season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    expect(totalRounds(season)).toBe(4);
    expect(season.rounds.map((r) => r.trackId)).toEqual(TRACK_IDS);
    expect(season.rounds.every((r) => r.playerPosition === null)).toBe(true);
    expect(isSeasonComplete(season)).toBe(false);
    expect(nextRoundIndex(season)).toBe(0);
  });

  it("treats a season with no rounds as never complete", () => {
    const empty = createSeason([], "2026-01-01T00:00:00.000Z");
    expect(isSeasonComplete(empty)).toBe(false);
    expect(nextRoundIndex(empty)).toBe(-1);
  });
});

describe("recordRoundResult", () => {
  it("fills in the round immutably", () => {
    const season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    const updated = recordRoundResult(season, 0, 2);
    expect(updated).not.toBe(season);
    expect(updated.rounds[0].playerPosition).toBe(2);
    expect(season.rounds[0].playerPosition).toBeNull();
    expect(nextRoundIndex(updated)).toBe(1);
  });

  it("ignores an out-of-range round index or invalid position", () => {
    const season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    expect(recordRoundResult(season, -1, 1)).toBe(season);
    expect(recordRoundResult(season, 4, 1)).toBe(season);
    expect(recordRoundResult(season, 0, 0)).toBe(season);
    expect(recordRoundResult(season, 0, 1.5)).toBe(season);
  });
});

describe("computeStandings", () => {
  it("awards the player and the single opponent inversely", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 1); // player wins
    season = recordRoundResult(season, 1, 1); // player wins
    season = recordRoundResult(season, 2, 2); // AI wins
    const standings = computeStandings(season);
    expect(standings.playerPoints).toBe(25 + 25 + 18);
    expect(standings.aiPoints).toBe(18 + 18 + 25);
    expect(standings.playerWins).toBe(2);
    expect(standings.aiWins).toBe(1);
    expect(standings.completedRounds).toBe(3);
    expect(standings.totalRounds).toBe(4);
  });

  it("is all zeros before any round is raced", () => {
    const standings = computeStandings(createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z"));
    expect(standings).toMatchObject({ playerPoints: 0, aiPoints: 0, completedRounds: 0 });
  });
});

describe("seasonChampion", () => {
  function completedWith(playerPositions: number[]): ChampionshipSeason {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    playerPositions.forEach((position, i) => {
      season = recordRoundResult(season, i, position);
    });
    return season;
  }

  it("is null until every round is raced", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 1);
    expect(seasonChampion(season)).toBeNull();
  });

  it("names the player when they out-score the AI", () => {
    expect(seasonChampion(completedWith([1, 1, 1, 2]))).toBe("player");
  });

  it("names the AI when it out-scores the player", () => {
    expect(seasonChampion(completedWith([2, 2, 2, 1]))).toBe("ai");
  });

  it("reports a tie when the points are level", () => {
    expect(seasonChampion(completedWith([1, 2, 1, 2]))).toBe("tie");
  });
});

describe("parseChampRound", () => {
  it("parses a non-negative round index", () => {
    expect(parseChampRound("0")).toBe(0);
    expect(parseChampRound("3")).toBe(3);
    expect(parseChampRound("2.5")).toBe(2); // parseInt truncates, same as parseRaceLaps
  });

  it("returns null for absent or invalid values", () => {
    expect(parseChampRound(null)).toBeNull();
    expect(parseChampRound("")).toBeNull();
    expect(parseChampRound("abc")).toBeNull();
    expect(parseChampRound("-1")).toBeNull();
  });
});

describe("isChampionshipSeason", () => {
  it("accepts a created season", () => {
    expect(isChampionshipSeason(createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z"))).toBe(true);
  });

  it("rejects malformed values", () => {
    expect(isChampionshipSeason(null)).toBe(false);
    expect(isChampionshipSeason("nope")).toBe(false);
    expect(isChampionshipSeason({ schemaVersion: 2, createdAt: "x", rounds: [] })).toBe(false);
    expect(isChampionshipSeason({ schemaVersion: 1, createdAt: 5, rounds: [] })).toBe(false);
    expect(isChampionshipSeason({ schemaVersion: 1, createdAt: "x", rounds: "nope" })).toBe(false);
    expect(
      isChampionshipSeason({ schemaVersion: 1, createdAt: "x", rounds: [{ trackId: "nope", playerPosition: null }] })
    ).toBe(false);
    expect(
      isChampionshipSeason({ schemaVersion: 1, createdAt: "x", rounds: [{ trackId: "monza", playerPosition: 0 }] })
    ).toBe(false);
    expect(
      isChampionshipSeason({ schemaVersion: 1, createdAt: "x", rounds: [{ trackId: "monza", playerPosition: 1 }] })
    ).toBe(true);
  });
});
