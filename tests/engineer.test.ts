import { describe, expect, it } from "vitest";
import { createEngineerState, engineerStep } from "../lib/race/engineer";
import { createHudSnapshot, type HudSnapshot } from "../lib/race/hud";
import type { TowerEntry } from "../lib/race/racePosition";

function entry(code: string, position: number, interval: number | null, isPlayer = false): TowerEntry {
  return {
    code,
    color: "#ffffff",
    position,
    gapSeconds: interval,
    intervalSeconds: interval,
    lapsDown: 0,
    intervalLapsDown: 0,
    lastLapSeconds: null,
    bestLapSeconds: null,
    isFastestLap: false,
    trackLimitStage: null,
    trackLimitWarningNumber: null,
    isPlayer,
  };
}

function running(): { hud: HudSnapshot; state: ReturnType<typeof createEngineerState> } {
  const hud = createHudSnapshot("race", 3);
  const state = createEngineerState();
  hud.lapSeconds = 1;
  hud.position = 5;
  hud.tower = [entry("VER", 1, null), entry("NOR", 4, 2), entry("YOU", 5, 3, true), entry("LEC", 6, 2)];
  expect(engineerStep(state, hud, 0.25)).toEqual(["Lights out. Keep it clean into turn one."]);
  return { hud, state };
}

describe("race engineer", () => {
  it("opens the race once, at lights out", () => {
    const { hud, state } = running();
    expect(engineerStep(state, hud, 0.25)).toEqual([]);
  });

  it("calls position changes only after the opening shuffle, with a cooldown", () => {
    const { hud, state } = running();
    hud.position = 4;
    expect(engineerStep(state, hud, 1)).toEqual([]); // too early
    engineerStep(state, hud, 25);
    hud.position = 3;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Good move. P3."]);
    hud.position = 4;
    expect(engineerStep(state, hud, 0.25)).toEqual([]); // cooling down
  });

  it("calls overtake range from the tower interval", () => {
    const { hud, state } = running();
    engineerStep(state, hud, 30);
    hud.tower = [entry("VER", 1, null), entry("NOR", 4, 2), entry("YOU", 5, 0.6, true), entry("LEC", 6, 2)];
    expect(engineerStep(state, hud, 0.25)).toEqual(["Gap to NOR is 0.6. You're in overtake range."]);
  });

  it("warns about worn tyres once per stint, and resets after a stop", () => {
    const { hud, state } = running();
    hud.tyreWear01 = 0.8;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Tyres are going off. Box when you're ready, O to request."]);
    expect(engineerStep(state, hud, 0.25)).toEqual([]);
    hud.pitStops = 1;
    hud.tyreWear01 = 0;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Good stop. Push now, tyres are fresh."]);
  });

  it("signs off with the result", () => {
    const { hud, state } = running();
    hud.result = { kind: "race", position: 2, laps: 3, rows: [], penaltySeconds: 0, disqualified: false, champRound: null, points: 18 };
    expect(engineerStep(state, hud, 0.25)).toEqual(["P2, that's a podium! Great job."]);
    expect(engineerStep(state, hud, 0.25)).toEqual([]);
  });

  it("warns of forecast rain once early and once when it is close, and knows what tyre you are on", () => {
    const { hud, state } = running();
    hud.forecastTo = "rain";
    hud.forecastInSeconds = 100;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Rain is forecast in about 100 seconds. Think about inters."]);
    expect(engineerStep(state, hud, 0.25)).toEqual([]);
    hud.forecastInSeconds = 20;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Rain is very close now. Inters are the safe call."]);
    hud.weather = "rain";
    expect(engineerStep(state, hud, 0.25)).toEqual(["Rain is here. Grip is way down. Fit inters, press 4."]);
    hud.weather = "clear";
    hud.compound = "intermediate";
    hud.forecastTo = null;
    expect(engineerStep(state, hud, 0.25)).toEqual(["Rain has stopped. The track will dry, slicks soon."]);
  });
});
