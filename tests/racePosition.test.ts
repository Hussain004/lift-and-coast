import { describe, expect, it } from "vitest";
import { computeRacePosition } from "../lib/race/racePosition";

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
