import { describe, expect, it } from "vitest";
import {
  classifyRace,
  createFinishTracker,
  updateFinishTracker,
  type ClassificationEntrant,
} from "../lib/race/classification";

function entrant(code: string, extra: Partial<ClassificationEntrant> = {}): ClassificationEntrant {
  return {
    code,
    name: null,
    teamId: null,
    color: "#fff",
    isPlayer: code === "YOU",
    laps: 0,
    livePosition: 1,
    bestLapSeconds: null,
    penaltySeconds: 0,
    ...extra,
  };
}

describe("finish tracker", () => {
  it("waves the flag when the leader - not the player - completes the distance", () => {
    const t = createFinishTracker(3);
    expect(updateFinishTracker(t, [1, 1, 1], 3, 60).finalLapNow).toBe(false);
    expect(updateFinishTracker(t, [2, 2, 1], 3, 120).finalLapNow).toBe(true);
    const flag = updateFinishTracker(t, [2, 3, 2], 3, 180);
    expect(flag.chequeredNow).toBe(true);
    expect(flag.finishedNow).toEqual([1]);
    // The player (index 0) finishes on their next crossing.
    expect(updateFinishTracker(t, [3, 3, 2], 3, 182).finishedNow).toEqual([0]);
    // The lapped car takes the flag one lap short, the next time it crosses.
    expect(updateFinishTracker(t, [3, 3, 3], 3, 240).finishedNow).toEqual([2]);
    expect(t.finishLaps).toEqual([3, 3, 3]);
  });

  it("classifies a lapped car one lap down when it crosses after the flag", () => {
    const t = createFinishTracker(2);
    updateFinishTracker(t, [3, 1], 3, 180); // flag; car 1 is two laps down
    expect(t.finishClock[1]).toBeNull();
    expect(updateFinishTracker(t, [3, 2], 3, 200).finishedNow).toEqual([1]);
    expect(t.finishLaps[1]).toBe(2);
  });

  it("finishes a car that crosses on the same frame as the leader", () => {
    const t = createFinishTracker(2);
    const u = updateFinishTracker(t, [3, 3], 3, 180);
    expect(u.finishedNow.sort()).toEqual([0, 1]);
  });
});

describe("classification", () => {
  it("orders finishers by time with penalties, then cars still running", () => {
    const t = createFinishTracker(4);
    updateFinishTracker(t, [3, 3, 2, 1], 3, 100); // 0 and 1 finish at 100
    t.finishClock[1] = 101; // car 1 crossed a second later
    const rows = classifyRace(
      [
        entrant("YOU", { penaltySeconds: 5, bestLapSeconds: 31 }),
        entrant("VER", { bestLapSeconds: 30.5 }),
        entrant("NOR", { laps: 2, livePosition: 4 }),
        entrant("LEC", { laps: 2, livePosition: 3 }),
      ],
      t
    );
    expect(rows.map((r) => r.code)).toEqual(["VER", "YOU", "LEC", "NOR"]);
    expect(rows[1].totalSeconds).toBe(105);
    expect(rows[0].points).toBe(25);
    expect(rows[0].fastestLap).toBe(true);
    expect(rows[2].totalSeconds).toBeNull();
  });
});
