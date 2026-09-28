import { describe, expect, it } from "vitest";
import {
  CHAMPIONSHIP_POINTS,
  computeDriverStandings,
  computeTeamStandings,
  PLAYER_KEY,
  seasonTrackIds,
  CALENDAR_2026,
  createSeason,
  isChampionshipSeason,
  isSeasonComplete,
  nextRoundIndex,
  parseChampRound,
  pointsForPosition,
  recordQualiResult,
  recordRoundResult,
  seasonChampion,
  totalRounds,
  type ChampionshipSeason,
  weekendStage,
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

function row(code: string, teamId: string, position: number, isPlayer = false) {
  return { code, name: null, teamId, position, points: pointsForPosition(position), isPlayer };
}

describe("driver and team standings", () => {
  it("scores the whole field from recorded classifications", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 2, [row("VER", "redbull", 1), row("GAS", "alpine", 2, true), row("NOR", "mclaren", 3)]);
    season = recordRoundResult(season, 1, 1, [row("GAS", "alpine", 1, true), row("NOR", "mclaren", 2), row("VER", "redbull", 3)]);
    const drivers = computeDriverStandings(season);
    expect(drivers.map((d) => d.code)).toEqual(["GAS", "VER", "NOR"]);
    expect(drivers[0]).toMatchObject({ key: PLAYER_KEY, points: 18 + 25, wins: 1, podiums: 2, finishes: [2, 1, null, null] });
    expect(drivers[1]).toMatchObject({ points: 25 + 15, wins: 1 });
    const teams = computeTeamStandings(season);
    expect(teams[0]).toMatchObject({ teamId: "alpine", points: 43 });
  });

  it("keeps the player in one row across a driver change, and scores legacy rounds", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 3); // saved before full results existed
    season = recordRoundResult(season, 1, 1, [row("HAM", "ferrari", 1, true), row("LEC", "ferrari", 2)]);
    const drivers = computeDriverStandings(season);
    const you = drivers.find((d) => d.isPlayer)!;
    expect(you.points).toBe(15 + 25);
    expect(you.code).toBe("HAM");
    expect(drivers.filter((d) => d.isPlayer)).toHaveLength(1);
  });

  it("is empty before any round is raced", () => {
    expect(computeDriverStandings(createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z"))).toEqual([]);
  });
});

describe("seasonChampion", () => {
  it("is null until every round is raced, then names the points leader", () => {
    let season = createSeason(["silverstone", "monza"], "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 2, [row("VER", "redbull", 1), row("GAS", "alpine", 2, true)]);
    expect(seasonChampion(season)).toBeNull();
    season = recordRoundResult(season, 1, 2, [row("VER", "redbull", 1), row("GAS", "alpine", 2, true)]);
    expect(seasonChampion(season)?.code).toBe("VER");
  });
});

describe("season lengths", () => {
  const known = ["silverstone", "monza", "spa", "suzuka", "monaco", "melbourne", "imola", "hockenheim"];
  it("runs the calendar in real round order, skipping circuits we do not have", () => {
    expect(seasonTrackIds("calendar", known)).toEqual(["melbourne", "suzuka", "monaco", "silverstone", "spa", "monza"]);
    expect(CALENDAR_2026[0]).toBe("melbourne");
    expect(CALENDAR_2026).toHaveLength(24);
  });
  it("appends the historic circuits for an every-circuit season", () => {
    expect(seasonTrackIds("all", known).slice(-2)).toEqual(["imola", "hockenheim"]);
    expect(seasonTrackIds("short", known)).toHaveLength(6);
  });
});

describe("result import guard", () => {
  it("accepts recorded results and rejects malformed rows", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordRoundResult(season, 0, 1, [row("GAS", "alpine", 1, true)]);
    expect(isChampionshipSeason(season)).toBe(true);
    const bad = JSON.parse(JSON.stringify(season));
    bad.rounds[0].result[0].points = -5;
    expect(isChampionshipSeason(bad)).toBe(false);
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

describe("championship weekend", () => {
  it("starts every round unqualified and un-raced", () => {
    const season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    expect(season.rounds.every((r) => r.qualiSpot === null)).toBe(true);
  });

  it("records quali spots and lets re-qualifying overwrite", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordQualiResult(season, 0, 2);
    expect(season.rounds[0].qualiSpot).toBe(2);
    season = recordQualiResult(season, 0, 1);
    expect(season.rounds[0].qualiSpot).toBe(1);
    // Out-of-range and invalid spots are no-ops.
    expect(recordQualiResult(season, 99, 1)).toBe(season);
    expect(recordQualiResult(season, 0, 0)).toBe(season);
    expect(recordQualiResult(season, 0, 21)).toBe(season);
    expect(recordQualiResult(season, 0, 2.5)).toBe(season);
  });

  it("walks practice-optional qualifying-gated weekend stages", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    expect(weekendStage(season, 0)).toBe("qualifying");
    expect(weekendStage(season, 99)).toBeNull();
    season = recordQualiResult(season, 0, 1);
    expect(weekendStage(season, 0)).toBe("race");
    season = recordRoundResult(season, 0, 1);
    expect(weekendStage(season, 0)).toBe("done");
  });

  it("accepts seasons saved before qualiSpot existed", () => {
    expect(
      isChampionshipSeason({
        schemaVersion: 1,
        createdAt: "x",
        rounds: [{ trackId: "monza", playerPosition: null }],
      })
    ).toBe(true);
    const legacy = {
      schemaVersion: 1,
      createdAt: "x",
      rounds: [{ trackId: "monza", playerPosition: null }],
    } as unknown as ChampionshipSeason;
    // Missing qualiSpot reads as unqualified, not as ready to race.
    expect(weekendStage(legacy, 0)).toBe("qualifying");
  });
});

describe("full-field qualifying", () => {
  it("records grid spots across the whole field", () => {
    let season = createSeason(TRACK_IDS, "2026-01-01T00:00:00.000Z");
    season = recordQualiResult(season, 0, 20);
    expect(season.rounds[0].qualiSpot).toBe(20);
    expect(weekendStage(season, 0)).toBe("race");
  });


});
