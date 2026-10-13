import { describe, expect, it } from "vitest";
import { buildDebrief, createRaceLog, lapTimesOf, orderAfterLap, recordLaps } from "../lib/race/raceLog";

const cars = [
  { code: "YOU", color: "#fff", isPlayer: true },
  { code: "AAA", color: "#f00", isPlayer: false },
  { code: "BBB", color: "#00f", isPlayer: false },
];

describe("race log", () => {
  it("logs each lap once, at the clock the count first reached it", () => {
    const log = createRaceLog(3);
    recordLaps(log, [0, 0, 0], 10, 3, "medium");
    recordLaps(log, [1, 0, 1], 80, 3, "medium");
    recordLaps(log, [1, 1, 1], 82, 3, "medium");
    recordLaps(log, [1, 1, 1], 90, 3, "medium");
    expect(log.completedAt).toEqual([[80], [82], [80]]);
    expect(log.playerCompounds).toEqual(["medium"]);
  });

  it("ignores a lap count that drops (rewind) and then re-crosses", () => {
    const log = createRaceLog(1);
    recordLaps(log, [1], 80, 3, "soft");
    recordLaps(log, [0], 85, 3, "soft");
    recordLaps(log, [1], 88, 3, "soft");
    expect(log.completedAt[0]).toEqual([80]);
  });

  it("does not log laps past the race distance", () => {
    const log = createRaceLog(1);
    recordLaps(log, [5], 300, 3, "hard");
    expect(log.completedAt[0]).toHaveLength(3);
  });

  it("derives lap times, with lap 1 from the lights going out", () => {
    const log = createRaceLog(1);
    recordLaps(log, [1], 90, 3, "soft");
    recordLaps(log, [2], 170, 3, "soft");
    expect(lapTimesOf(log, 0)).toEqual([90, 80]);
    log.startClock = 5;
    expect(lapTimesOf(log, 0)).toEqual([85, 80]);
  });

  it("orders cars by who crossed first, leaving out cars that have not finished the lap", () => {
    const log = createRaceLog(3);
    recordLaps(log, [1, 1, 0], 80, 2, "soft");
    log.completedAt[0] = [81];
    log.completedAt[1] = [80];
    expect(orderAfterLap(log, 1)).toEqual([1, 0]);
  });

  it("builds a lap chart and finds the fastest lap", () => {
    const log = createRaceLog(3);
    log.completedAt = [[90, 170], [88, 178], [95, 175]];
    const d = buildDebrief(log, cars, 2);
    expect(d.positions).toEqual([
      [2, 1, 3],
      [1, 3, 2],
    ]);
    expect(d.fastest).toEqual({ car: 0, lap: 2, seconds: 80 });
  });
});
