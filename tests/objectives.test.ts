import { describe, expect, it } from "vitest";
import type { ChampionshipRound, ChampionshipSeason } from "../lib/race/championship";
import { objectiveFor, objectiveMet, reputationTitle, REPUTATION_START, seasonObjectives } from "../lib/race/objectives";

const round = (playerPosition: number | null, mate?: number): ChampionshipRound => ({
  trackId: "monza",
  playerPosition,
  qualiSpot: null,
  result:
    playerPosition === null
      ? undefined
      : [
          { code: "YOU", name: null, teamId: "haas", position: playerPosition, points: 0, isPlayer: true },
          ...(mate === undefined ? [] : [{ code: "MAT", name: null, teamId: "haas", position: mate, points: 0, isPlayer: false }]),
        ],
});

describe("team objectives", () => {
  it("asks more of front-running teams, and a team-mate battle every second round", () => {
    expect(objectiveFor("ferrari", 0).kind).toBe("podium");
    expect(objectiveFor("williams", 0).kind).toBe("top-8");
    expect(objectiveFor("haas", 0).kind).toBe("points");
    expect(objectiveFor("ferrari", 1).kind).toBe("beat-teammate");
  });

  it("judges finishing positions and the team-mate duel", () => {
    expect(objectiveMet(objectiveFor("ferrari", 0), round(3))).toBe(true);
    expect(objectiveMet(objectiveFor("ferrari", 0), round(4))).toBe(false);
    expect(objectiveMet(objectiveFor("haas", 1), round(9, 12))).toBe(true);
    expect(objectiveMet(objectiveFor("haas", 1), round(12, 9))).toBe(false);
    expect(objectiveMet(objectiveFor("haas", 0), round(null))).toBeNull();
  });

  it("builds reputation from the rounds already raced, within 0-100", () => {
    const season: ChampionshipSeason = {
      schemaVersion: 1,
      createdAt: "x",
      rounds: [round(5), round(8, 14), round(null)],
    };
    const s = seasonObjectives(season, "haas");
    expect(s.outcomes).toEqual([true, true, null]);
    expect(s.reputation).toBe(REPUTATION_START + 16);
    const bad = seasonObjectives({ ...season, rounds: Array.from({ length: 30 }, () => round(20, 1)) }, "haas");
    expect(bad.reputation).toBe(0);
    expect(reputationTitle(90)).toBe("Team leader");
    expect(reputationTitle(10)).toBe("Under review");
  });
});
