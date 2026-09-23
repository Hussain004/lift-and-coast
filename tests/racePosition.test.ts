import { describe, expect, it } from "vitest";
import { buildTowerEntries, computeRacePosition, computeRacePositions, renderTowerHtml, towerOpponents } from "../lib/race/racePosition";

const TRACK_LENGTH = 5891;

describe("computeRacePosition", () => {
  it("puts the car further into the same lap ahead", () => {
    const player = { lapCount: 2, progressMeters: 1000 };
    const ai = { lapCount: 2, progressMeters: 500 };
    expect(computeRacePosition(player, ai, TRACK_LENGTH)).toBe(1);
    expect(computeRacePosition(ai, player, TRACK_LENGTH)).toBe(2);
  });

  it("puts the car with more completed laps ahead even if less far into the current lap", () => {
    const playerOneLapUp = { lapCount: 3, progressMeters: 10 };
    const aiMidLap = { lapCount: 2, progressMeters: 5000 };
    expect(computeRacePosition(playerOneLapUp, aiMidLap, TRACK_LENGTH)).toBe(1);
    expect(computeRacePosition(aiMidLap, playerOneLapUp, TRACK_LENGTH)).toBe(2);
  });

  it("breaks an exact tie in favor of the player (position 1)", () => {
    const even = { lapCount: 1, progressMeters: 2000 };
    expect(computeRacePosition(even, even, TRACK_LENGTH)).toBe(1);
  });
});

describe("computeRacePositions", () => {
  const P = (lapCount: number, progressMeters: number, speedMs = 30) => ({ lapCount, progressMeters, speedMs });

  it("ranks a full field by total distance", () => {
    const positions = computeRacePositions(
      [P(1, 1000), P(1, 3000), P(0, 5000), P(1, 2000)],
      TRACK_LENGTH
    );
    expect(positions).toEqual([3, 1, 4, 2]);
  });

  it("ranks lapped cars behind regardless of lap progress", () => {
    const positions = computeRacePositions([P(0, 5800), P(1, 100)], TRACK_LENGTH);
    expect(positions).toEqual([2, 1]);
  });

  it("breaks exact ties toward the lower index (player first)", () => {
    const even = P(1, 2000);
    expect(computeRacePositions([even, { ...even }], TRACK_LENGTH)).toEqual([1, 2]);
  });

  it("agrees with computeRacePosition on two-car fields", () => {
    const player = P(2, 1000);
    const ai = P(2, 500);
    expect(computeRacePositions([player, ai], TRACK_LENGTH)[0]).toBe(
      computeRacePosition(player, ai, TRACK_LENGTH)
    );
  });
});

describe("buildTowerEntries + renderTowerHtml", () => {
  const L = TRACK_LENGTH;
  const player = { code: "YOU", color: "#ffffff", progress: { lapCount: 1, progressMeters: 1000, speedMs: 40 } };

  it("marks the leader and gaps followers by their own speed", () => {
    const entries = buildTowerEntries(
      player,
      [{ code: "RIV", color: "#ff0000", progress: { lapCount: 1, progressMeters: 600, speedMs: 40 } }],
      L
    );
    expect(entries[0]).toMatchObject({ position: 1, gapSeconds: null, isPlayer: true });
    expect(entries[1].position).toBe(2);
    expect(entries[1].gapSeconds).toBeCloseTo(400 / 40, 9);
    expect(entries[1].lapsDown).toBe(0);
    const html = renderTowerHtml(entries);
    expect(html).toContain("LEADER");
    expect(html).toContain("+10.0");
    expect(html).toContain("RIV");
    // Leader first in the tower.
    expect(html.indexOf("P1")).toBeLessThan(html.indexOf("P2"));
  });

  it("shows laps down instead of seconds past a lap", () => {
    const entries = buildTowerEntries(
      player,
      [{ code: "LAP", color: "#00ff00", progress: { lapCount: 0, progressMeters: 900, speedMs: 40 } }],
      L
    );
    // 5891 + 100 gap = 5991m = 1.017 laps down.
    expect(entries[1].lapsDown).toBe(1);
    expect(renderTowerHtml(entries)).toContain("+1 LAP");
  });

  it("floors a stationary follower instead of dividing by zero", () => {
    const entries = buildTowerEntries(
      player,
      [{ code: "STOP", color: "#0000ff", progress: { lapCount: 1, progressMeters: 900, speedMs: 0 } }],
      L
    );
    expect(Number.isFinite(entries[1].gapSeconds)).toBe(true);
  });

  it("renders only the compact F1 interval and gap columns", () => {
    const entries = buildTowerEntries(
      {
        code: "YOU",
        name: "Alex Runner",
        number: 44,
        teamId: "ferrari",
        color: "#ffffff",
        progress: {
          lapCount: 2,
          progressMeters: 1200,
          speedMs: 40,
          lastLapSeconds: 83.125,
          bestLapSeconds: 82.9,
          trackLimitStage: "warning",
          trackLimitWarningNumber: 2,
        },
      },
      [
        {
          code: "RIV",
          name: "Rival Driver",
          number: 1,
          teamId: "red-bull",
          color: "#ff0000",
          progress: { lapCount: 2, progressMeters: 1000, speedMs: 40, bestLapSeconds: 84.2 },
        },
      ],
      L
    );
    const html = renderTowerHtml(entries);
    expect(entries[0]).toMatchObject({
      name: "Alex Runner",
      number: 44,
      lastLapSeconds: 83.125,
      bestLapSeconds: 82.9,
      trackLimitWarningNumber: 2,
    });
    expect(html).toContain("YOU");
    expect(html).toContain("+5.0");
    expect(html).not.toContain("Alex Runner");
    expect(html).not.toContain("1:23.125");
    expect(html).not.toContain("W2/3");
  });

  it("escapes hostile codes", () => {
    const entries = buildTowerEntries(
      { code: "<b>", color: "#fff", progress: { lapCount: 2, progressMeters: 0, speedMs: 1 } },
      [],
      L
    );
    expect(renderTowerHtml(entries)).not.toContain("<b>");
    expect(renderTowerHtml(entries)).toContain("&lt;b&gt;");
  });
});

describe("towerOpponents", () => {
  it("pairs rivals with progress and defaults missing cars to the line", () => {
    const out = towerOpponents(
      [
        { code: "A", color: "#111111" },
        { code: "B", color: "#222222" },
      ],
      [{ lapCount: 1, progressMeters: 100 }]
    );
    expect(out[0]).toEqual({ code: "A", color: "#111111", progress: { lapCount: 1, progressMeters: 100 } });
    expect(out[1]).toEqual({ code: "B", color: "#222222", progress: { lapCount: 0, progressMeters: 0 } });
  });
});
