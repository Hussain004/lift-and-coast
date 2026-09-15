import { describe, expect, it } from "vitest";
import { computeAIControls } from "../lib/ai/pathFollower";

// A simple straight line along -Z (matches the car's own forward-is--Z
// convention at yaw 0), long enough for every lookahead window used
// internally.
function buildStraightLine(length: number): [number, number, number][] {
  const line: [number, number, number][] = [];
  for (let i = 0; i < length; i++) {
    line.push([0, 0, -i]);
  }
  return line;
}

describe("computeAIControls steering sign", () => {
  it("steers left (positive) when the lookahead point is to the left of the car's heading", () => {
    const line = buildStraightLine(200);
    // Shift the whole line so the lookahead point sits at negative x
    // relative to the car at the origin facing yaw=0 (forward -Z).
    const shifted = line.map(([x, y, z]) => [x - 10, y, z] as [number, number, number]);
    const controls = computeAIControls(shifted, 0, 0, 0, 20);
    expect(controls.steer).toBeGreaterThan(0);
  });

  it("steers right (negative) when the lookahead point is to the right of the car's heading", () => {
    const line = buildStraightLine(200);
    const shifted = line.map(([x, y, z]) => [x + 10, y, z] as [number, number, number]);
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
  it("gives full throttle, no brake, well below the max speed on a straight", () => {
    const line = buildStraightLine(200);
    const controls = computeAIControls(line, 0, 0, 0, 10);
    expect(controls.throttle).toBe(1);
    expect(controls.brake).toBe(0);
  });

  it("brakes when going faster than the max straight-line speed", () => {
    const line = buildStraightLine(200);
    const controls = computeAIControls(line, 0, 0, 0, 100);
    expect(controls.brake).toBeGreaterThan(0);
    expect(controls.throttle).toBe(0);
  });

  it("lowers target speed (throttle backs off sooner) approaching a sharp turn than on a straight", () => {
    // A line that goes straight, then turns sharply - the curvature
    // lookahead sits ahead of the car, on the straight portion just before
    // the turn.
    const n = 200;
    const line: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (i < 100) {
        line.push([0, 0, -i]);
      } else {
        const turnI = i - 100;
        line.push([turnI, 0, -100 - turnI]);
      }
    }
    const speed = 40;
    const straightControls = computeAIControls(line, 0, 0, 0, speed);
    // Positioned just before the turn begins, still facing along -Z.
    const nearTurnControls = computeAIControls(line, 0, -70, 0, speed);
    // Both see the same speed; the one closer to the turn should be
    // commanding less throttle / more brake than the one further away on
    // the straight, since its curvature lookahead window reaches further
    // into the turn.
    expect(nearTurnControls.throttle - nearTurnControls.brake).toBeLessThan(
      straightControls.throttle - straightControls.brake
    );
  });
});
