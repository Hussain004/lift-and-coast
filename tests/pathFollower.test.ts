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
    line.push({
      position: [0, 0, -i],
      targetSpeedMs,
      boostedTargetSpeedMs: targetSpeedMs,
      boostEligible: false,
      zone: "throttle",
      distanceToNextMeters: 1,
    });
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

  it("smooths the opt-in corner-to-straight pace cap across the threshold", () => {
    const line = buildStraightLine(200, 70).map((point) => ({
      ...point,
      steeringMaxPace: 1.1,
      paceCapMode: "smooth" as const,
    }));
    const justAbove = computeAIControls(
      line.map((point) => ({ ...point, targetSpeedMs: 70.01, boostedTargetSpeedMs: 70.01 })),
      0,
      0,
      0,
      80,
      false,
      1.28
    );
    const justBelow = computeAIControls(
      line.map((point) => ({ ...point, targetSpeedMs: 69.99, boostedTargetSpeedMs: 69.99 })),
      0,
      0,
      0,
      80,
      false,
      1.28
    );
    expect(Math.abs(justAbove.throttle - justBelow.throttle)).toBeLessThan(0.01);
    expect(Math.abs(justAbove.brake - justBelow.brake)).toBeLessThan(0.01);
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

  it("targets boostedTargetSpeedMs instead of targetSpeedMs when useBoostedSpeed is true", () => {
    // Confirms the override param actually switches which precomputed
    // field drives the decision - not just accepted and ignored, the exact
    // failure mode that would make a harness sweep of this look identical
    // to baseline and hide a real bug.
    const line: RacingLinePoint[] = buildStraightLine(200, 20).map((p) => ({
      ...p,
      boostedTargetSpeedMs: 70,
    }));
    const speed = 40; // above the unboosted target, below the boosted one
    const unboosted = computeAIControls(line, 0, 0, 0, speed, false);
    const boosted = computeAIControls(line, 0, 0, 0, speed, true);
    expect(unboosted.brake).toBeGreaterThan(0);
    expect(unboosted.throttle).toBe(0);
    expect(boosted.throttle).toBeGreaterThan(0);
    expect(boosted.brake).toBe(0);
  });

  it("exposes the nearest point's own boostEligible flag unchanged", () => {
    const eligible = buildStraightLine(200, 40).map((p) => ({ ...p, boostEligible: true }));
    const notEligible = buildStraightLine(200, 40);
    expect(computeAIControls(eligible, 0, 0, 0, 20).boostEligible).toBe(true);
    expect(computeAIControls(notEligible, 0, 0, 0, 20).boostEligible).toBe(false);
  });
});

describe("personality inputs (paceScale, lateralOffsetMeters)", () => {
  it("defaults to the reference behavior", () => {
    const line = buildStraightLine(200);
    expect(computeAIControls(line, 0, 0, 0, 20)).toEqual(
      computeAIControls(line, 0, 0, 0, 20, false, 1, 0)
    );
  });

  it("scales throttle with pace and steers off-line with offset", () => {
    const line = buildStraightLine(200, 70);
    const slow = computeAIControls(line, 0, 0, 0, 60, false, 0.95, 0);
    const fast = computeAIControls(line, 0, 0, 0, 60, false, 1.03, 0);
    expect(fast.throttle).toBeGreaterThan(slow.throttle);
    const centered = computeAIControls(line, 0, 0, 0, 60, false, 1, 0);
    const offset = computeAIControls(line, 0, 0, 0, 60, false, 1, 1.5);
    expect(Math.abs(centered.steer)).toBeLessThan(1e-9);
    expect(offset.steer).not.toBe(0);
  });

  it("gives a fast Ace entry more throttle without turning slow corners into full-throttle inputs", () => {
    const fastLine = buildStraightLine(200, 80);
    const fast = computeAIControls(fastLine, 0, 0, 0, 85, false, 1.18, 0);
    expect(fast.throttle).toBe(1);

    const slowCorner = buildStraightLine(200, 40);
    const cautious = computeAIControls(slowCorner, 0, 0, 0, 45, false, 1.18, 0);
    expect(cautious.throttle).toBeCloseTo((40 * 1.18 - 45) / 8, 6);
  });

  it("clamps garbage pace instead of chasing it", () => {
    const line = buildStraightLine(200, 70);
    const sane = computeAIControls(line, 0, 0, 0, 60, false, 1, 0);
    const wild = computeAIControls(line, 0, 0, 0, 60, false, 99, 0);
    expect(wild.throttle).toBeLessThanOrEqual(1);
    expect(wild.throttle).toBeGreaterThanOrEqual(sane.throttle);
  });
});
