import { describe, expect, it } from "vitest";
import { createLapTimer, formatLapTime, standingsLapCount } from "../lib/race/lapTimer";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

describe("createLapTimer", () => {
  it("does not count a lap from spawn-frame jitter around the line", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    // Small back-and-forth around (0,0) relative to the line, like a car
    // settling on its suspension at spawn - none of this should arm a lap.
    const jitterPositions = [
      { x: track.startPos.x - 0.05, z: track.startPos.z - 0.05 },
      { x: track.startPos.x + 0.05, z: track.startPos.z + 0.05 },
      { x: track.startPos.x - 0.02, z: track.startPos.z - 0.02 },
      { x: track.startPos.x + 0.03, z: track.startPos.z + 0.03 },
    ];
    let lastState;
    for (const pos of jitterPositions) {
      lastState = timer.update(pos, 1 / 60);
    }
    expect(lastState!.lapCount).toBe(0);
    expect(lastState!.crossedFinishLine).toBe(false);
  });

  it("counts a lap when the car drives away and comes back around to the line", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    const forward = {
      x: -Math.sin(track.startPos.headingRad),
      z: -Math.cos(track.startPos.headingRad),
    };
    const at = (signedForward: number) => ({
      x: track.startPos.x + forward.x * signedForward,
      z: track.startPos.z + forward.z * signedForward,
    });

    // Drive away from the line, then approach it again from behind.
    timer.update(at(0), 1 / 60);
    timer.update(at(50), 60); // a lap's worth of driving
    timer.update(at(-10), 1 / 60);
    timer.update(at(-2), 1 / 60);
    const crossing = timer.update(at(1), 1 / 60);

    expect(crossing.crossedFinishLine).toBe(true);
    expect(crossing.lapCount).toBe(1);
    expect(crossing.lastLapSeconds).toBeGreaterThan(0);
    expect(crossing.currentLapSeconds).toBeCloseTo(1 / 60, 5);
  });

  it("does not double-count a lap without leaving the line's vicinity again", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    const forward = {
      x: -Math.sin(track.startPos.headingRad),
      z: -Math.cos(track.startPos.headingRad),
    };
    const at = (signedForward: number) => ({
      x: track.startPos.x + forward.x * signedForward,
      z: track.startPos.z + forward.z * signedForward,
    });

    timer.update(at(-5), 60);
    timer.update(at(1), 1 / 60); // completes lap 1
    // Wobbling right around the line without going meaningfully behind it
    // again should not register a second lap.
    const result = timer.update(at(-1), 1 / 60);
    const result2 = timer.update(at(1), 1 / 60);

    expect(result.crossedFinishLine).toBe(false);
    expect(result2.crossedFinishLine).toBe(false);
    expect(result2.lapCount).toBe(1);
  });

  it("tracks best lap across multiple laps", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    const forward = {
      x: -Math.sin(track.startPos.headingRad),
      z: -Math.cos(track.startPos.headingRad),
    };
    const at = (signedForward: number) => ({
      x: track.startPos.x + forward.x * signedForward,
      z: track.startPos.z + forward.z * signedForward,
    });

    const driveOneLap = (seconds: number) => {
      timer.update(at(-5), 1 / 60);
      for (let t = 0; t < seconds * 60; t++) timer.update(at(-4), 1 / 60);
      return timer.update(at(1), 1 / 60);
    };

    const lap1 = driveOneLap(90);
    const lap2 = driveOneLap(75);
    const lap3 = driveOneLap(80);

    expect(lap1.lapCount).toBe(1);
    expect(lap2.bestLapSeconds).toBeLessThan(lap1.lastLapSeconds!);
    expect(lap3.bestLapSeconds).toBe(lap2.bestLapSeconds);
    expect(lap3.lapCount).toBe(3);
  });

  it("ignores a crossing far from the line laterally", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    const forward = {
      x: -Math.sin(track.startPos.headingRad),
      z: -Math.cos(track.startPos.headingRad),
    };
    const right = { x: -forward.z, z: forward.x };
    const at = (signedForward: number, lateral: number) => ({
      x: track.startPos.x + forward.x * signedForward + right.x * lateral,
      z: track.startPos.z + forward.z * signedForward + right.z * lateral,
    });

    timer.update(at(-5, 40), 1 / 60);
    const result = timer.update(at(1, 40), 1 / 60);

    expect(result.crossedFinishLine).toBe(false);
    expect(result.lapCount).toBe(0);
  });

  it("rewindBy rolls the current lap's elapsed time back and returns the new value", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    for (let i = 0; i < 60; i++) timer.update(track.startPos, 1 / 60);
    const rolledBackTo = timer.rewindBy(0.4);
    expect(rolledBackTo).toBeCloseTo(1 - 0.4, 5);
    const result = timer.update(track.startPos, 1 / 60);
    // 1 second accumulated, minus 0.4 rewound, plus this call's own tick.
    expect(result.currentLapSeconds).toBeCloseTo(1 - 0.4 + 1 / 60, 5);
  });

  it("rewindBy floors at zero rather than going negative", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    timer.update(track.startPos, 1 / 60);
    expect(timer.rewindBy(100)).toBe(0);
    const result = timer.update(track.startPos, 1 / 60);
    expect(result.currentLapSeconds).toBeCloseTo(1 / 60, 5);
  });
});

describe("formatLapTime", () => {
  it("formats null as a placeholder", () => {
    expect(formatLapTime(null)).toBe("--:--.---");
  });

  it("formats seconds as minutes:seconds.millis", () => {
    expect(formatLapTime(83.456)).toBe("1:23.456");
    expect(formatLapTime(5.02)).toBe("0:05.020");
  });
});

describe("createLapTimer startsBehindLine", () => {
  const forward = {
    x: -Math.sin(track.startPos.headingRad),
    z: -Math.cos(track.startPos.headingRad),
  };
  const at = (signedForward: number) => ({
    x: track.startPos.x + forward.x * signedForward,
    z: track.startPos.z + forward.z * signedForward,
  });

  it("does not record a lap for the run up to the line from a grid spot behind it", () => {
    const timer = createLapTimer({
      startPos: track.startPos,
      lineHalfWidth: 6,
      startsBehindLine: true,
    });
    timer.update(at(-9), 1 / 60);
    const crossing = timer.update(at(1), 1 / 60);
    expect(crossing.crossedFinishLine).toBe(false);
    expect(crossing.lapCount).toBe(0);
    expect(crossing.lastLapSeconds).toBeNull();
    expect(crossing.bestLapSeconds).toBeNull();
  });

  it("does not miss the grid grace crossing when the first post-go sample is past the line", () => {
    const timer = createLapTimer({
      startPos: track.startPos,
      lineHalfWidth: 6,
      startsBehindLine: true,
    });
    timer.prime(at(-9));
    const grace = timer.update(at(1), 1 / 60);
    expect(grace.crossedFinishLine).toBe(false);
    expect(grace.lapCount).toBe(0);
    expect(grace.awaitingStart).toBe(false);

    timer.update(at(50), 60);
    timer.update(at(-10), 1 / 60);
    const lap = timer.update(at(1), 1 / 60);
    expect(lap.crossedFinishLine).toBe(true);
    expect(lap.lapCount).toBe(1);
  });

  it("times normally after the forgiven crossing", () => {
    const timer = createLapTimer({
      startPos: track.startPos,
      lineHalfWidth: 6,
      startsBehindLine: true,
    });
    timer.update(at(-9), 1 / 60);
    timer.update(at(1), 1 / 60);
    timer.update(at(50), 60);
    timer.update(at(-10), 1 / 60);
    const crossing = timer.update(at(1), 1 / 60);
    expect(crossing.crossedFinishLine).toBe(true);
    expect(crossing.lapCount).toBe(1);
    expect(crossing.lastLapSeconds).toBeGreaterThan(0);
  });

  it("behaves exactly as before without the flag", () => {
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    timer.update(at(-9), 60);
    const crossing = timer.update(at(1), 1 / 60);
    expect(crossing.crossedFinishLine).toBe(true);
    expect(crossing.lapCount).toBe(1);
  });

  it("never counts a roll back off the grid and forward again as a lap", () => {
    // Pole car creeping backward down a sloped grid, then launching: the
    // crossing arms and fires within seconds - not a lap, clock untouched.
    const timer = createLapTimer({ startPos: track.startPos, lineHalfWidth: 6 });
    timer.update(at(0), 1 / 60);
    timer.update(at(-4), 2);
    const crossing = timer.update(at(1), 1);
    expect(crossing.crossedFinishLine).toBe(false);
    expect(crossing.lapCount).toBe(0);
    expect(crossing.bestLapSeconds).toBeNull();
    expect(crossing.currentLapSeconds).toBeCloseTo(3 + 1 / 60, 5);
  });
});

describe("standingsLapCount", () => {
  const L = 5891;
  const state = (lapCount: number, currentLapSeconds: number, awaitingStart = false) => ({
    lapCount,
    currentLapSeconds,
    awaitingStart,
    lastLapSeconds: null,
    bestLapSeconds: null,
    crossedFinishLine: false,
  });

  it("counts a car on or behind the line at the start as lap -1", () => {
    expect(standingsLapCount(state(0, 2), L - 3, L)).toBe(-1);
    expect(standingsLapCount(state(0, 45, true), L - 10, L)).toBe(-1);
  });

  it("leaves real progress alone", () => {
    expect(standingsLapCount(state(0, 2), 12, L)).toBe(0);
    expect(standingsLapCount(state(0, 70), L - 50, L)).toBe(0);
    expect(standingsLapCount(state(2, 3), L - 5, L)).toBe(2);
  });
});
