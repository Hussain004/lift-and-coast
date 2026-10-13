import { describe, expect, it } from "vitest";
import { MAX_RACE_HISTORY, capHistory, isRaceHistoryRecord, type RaceHistoryRecord } from "../lib/race/raceHistory";
import { importSaveData } from "../lib/persistence/saveBundle";

const rec = (over: Partial<RaceHistoryRecord> = {}): RaceHistoryRecord => ({
  schemaVersion: 1,
  at: "2026-10-14T10:00:00.000Z",
  trackId: "monza",
  laps: 3,
  rivals: 19,
  aiLevel: "pro",
  teamId: "alpine",
  driverCode: "GAS",
  finish: 2,
  points: 18,
  fastestLap: false,
  penaltySeconds: 0,
  disqualified: false,
  champRound: null,
  sprint: false,
  ...over,
});

describe("race history", () => {
  it("accepts a well-formed record and rejects broken ones", () => {
    expect(isRaceHistoryRecord(rec())).toBe(true);
    expect(isRaceHistoryRecord(rec({ finish: 0 }))).toBe(false);
    expect(isRaceHistoryRecord(rec({ champRound: -1 }))).toBe(false);
    expect(isRaceHistoryRecord({ ...rec(), trackId: 5 })).toBe(false);
    expect(isRaceHistoryRecord(null)).toBe(false);
  });

  it("keeps the newest records up to the cap", () => {
    const many = Array.from({ length: MAX_RACE_HISTORY + 20 }, (_, i) =>
      rec({ at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() })
    );
    const capped = capHistory(many);
    expect(capped).toHaveLength(MAX_RACE_HISTORY);
    expect(capped[0].at > capped[capped.length - 1].at).toBe(true);
  });

  it("save import accepts v2 bundles with no history and rejects a bad history", async () => {
    await expect(importSaveData({ schemaVersion: 2, personalBests: {} })).resolves.toBeUndefined();
    await expect(importSaveData({ personalBests: {}, raceHistory: [rec()] })).resolves.toBeUndefined();
    await expect(importSaveData({ personalBests: {}, raceHistory: [{ nope: 1 }] })).rejects.toThrow("bad race history");
  });
});
