import { describe, expect, it } from "vitest";
import { computeAIControls } from "../lib/ai/pathFollower";
import type { RacingLinePoint } from "../lib/tracks/racingLine";

// A simple straight line along -Z (matches the car's own forward-is--Z
// convention at yaw 0), long enough for every lookahead window used
// internally. targetSpeedMs/zone are arbitrary here - computeAIControls
// no longer derives speed from geometry itself (see pathFollower.ts's own
// comment), it just reads whatever the line's own precomputed profile
// says, so these tests can set that directly instead of needing sharp
// synthetic corners to trigger it.
function buildStraightLine(length: number, targetSpeedMs = 70): RacingLinePoint[] {
  const line: RacingLinePoint[] = [];
  for (let i = 0; i < length; i++) {
    line.push({ position: [0, 0, -i], targetSpeedMs, zone: "throttle" });
  }
  return line;
}

describe("computeAIControls steering sign", () => {
  it("steers left (positive) when the lookahead point is to the left of the car's heading", () => {
    const line = buildStraightLine(200);
    // Shift the whole line so the lookahead point sits at negative x
    // relative to the car at the origin facing yaw=0 (forward -Z).
    const shifted = line.map((p) => ({
      ...p,
      position: [p.position[0] - 10, p.position[1], p.position[2]] as [number, number, number],
    }));
    const controls = computeAIControls(shifted, 0, 0, 0, 20);
    expect(controls.steer).toBeGreaterThan(0);
  });

  it("steers right (negative) when the lookahead point is to the right of the car's heading", () => {
    const line = buildStraightLine(200);
    const shifted = line.map((p) => ({
      ...p,
      position: [p.position[0] + 10, p.position[1], p.position[2]] as [number, number, number],
    }));
    const controls = computeAIControls(shifted, 0, 0, 0, 20);
    expect(controls.steer).toBeLessThan(0);
  });

  it("steers near zero when already centered on a straight line dead ahead", () => {
    const line = buildStraightLine(200);
    const controls = computeAIControls(line, 0, 0, 0, 20);
    expect(Math.abs(controls.steer)).toBeLessThan(0.05);
  });
});

describe("computeAIControls speed control", () => {
  it("gives full throttle, no brake, when well below the line's target speed", () => {
    const line = buildStraightLine(200, 70);
    const controls = computeAIControls(line, 0, 0, 0, 10);
    expect(controls.throttle).toBe(1);
    expect(controls.brake).toBe(0);
  });

  it("brakes when going faster than the line's target speed", () => {
    const line = buildStraightLine(200, 70);
    const controls = computeAIControls(line, 0, 0, 0, 100);
    expect(controls.brake).toBeGreaterThan(0);
    expect(controls.throttle).toBe(0);
  });

  it("reads the target speed from the nearest point on the line, not a fixed value", () => {
    // Two lines identical except for the target speed baked into the
    // nearest point - confirms computeAIControls actually looks this up
    // per-position rather than hardcoding or ignoring it.
    const slowLine = buildStraightLine(200, 20);
    const fastLine = buildStraightLine(200, 70);
    const speed = 40;
    const onSlowLine = computeAIControls(slowLine, 0, 0, 0, speed);
    const onFastLine = computeAIControls(fastLine, 0, 0, 0, speed);
    expect(onSlowLine.brake).toBeGreaterThan(0);
    expect(onSlowLine.throttle).toBe(0);
    expect(onFastLine.throttle).toBeGreaterThan(0);
    expect(onFastLine.brake).toBe(0);
  });
});
