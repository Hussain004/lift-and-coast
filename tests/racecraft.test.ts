import { describe, expect, it } from "vitest";
import {
  decideOvertake,
  followPaceScale,
  slipstreamBonus,
  trackGapMeters,
  yieldPaceScale,
} from "../lib/ai/racecraft";

const TRACK = 5891;

describe("trackGapMeters", () => {
  it("measures signed gaps along the lap, across the line", () => {
    const own = { lapCount: 1, progressMeters: 5000 };
    expect(trackGapMeters(own, { lapCount: 1, progressMeters: 5050 }, TRACK)).toBe(50);
    expect(trackGapMeters(own, { lapCount: 1, progressMeters: 4950 }, TRACK)).toBe(-50);
    // Other across the line ahead: barely ahead, not a lap down.
    expect(trackGapMeters(own, { lapCount: 2, progressMeters: 100 }, TRACK)).toBeCloseTo(
      TRACK - 5000 + 100,
      6
    );
  });
});

describe("decideOvertake", () => {
  const base = {
    gapMeters: 8,
    closingSpeedMs: 3,
    speedMs: 70,
    leaderSpeedMs: 67,
    throttleZone: true,
    cornerAheadMeters: 300,
    aggression: 0.5,
    risk: 0.3,
    overtakeSide: 1 as const,
  };

  it("lunges on a straight when closing, sided by preference", () => {
    const d = decideOvertake(base);
    expect(d.attempt).toBe(true);
    expect(d.offsetMeters).toBeGreaterThan(0);
    expect(d.paceBonus).toBeGreaterThan(0);
    expect(decideOvertake({ ...base, overtakeSide: -1 }).offsetMeters).toBeLessThan(0);
  });

  it("refuses corners, slow speed, no closure, and far gaps", () => {
    expect(decideOvertake({ ...base, throttleZone: false }).attempt).toBe(false);
    expect(decideOvertake({ ...base, speedMs: 30 }).attempt).toBe(false);
    expect(decideOvertake({ ...base, closingSpeedMs: 0 }).attempt).toBe(false);
    expect(decideOvertake({ ...base, gapMeters: 40 }).attempt).toBe(false);
    expect(decideOvertake({ ...base, gapMeters: -5 }).attempt).toBe(false);
  });

  it("lets risk-takers lunge with less road, not the cautious", () => {
    expect(decideOvertake({ ...base, cornerAheadMeters: 80, risk: 0.9 }).attempt).toBe(true);
    expect(decideOvertake({ ...base, cornerAheadMeters: 80, risk: 0 }).attempt).toBe(false);
  });

  it("reaches further with aggression", () => {
    expect(decideOvertake({ ...base, gapMeters: 14, aggression: 1 }).attempt).toBe(true);
    expect(decideOvertake({ ...base, gapMeters: 14, aggression: 0 }).attempt).toBe(false);
  });

  it("squeezes past a parked car without lunge pace", () => {
    const d = decideOvertake({ ...base, gapMeters: 5, speedMs: 8, leaderSpeedMs: 0 });
    expect(d.attempt).toBe(true);
    expect(d.paceBonus).toBe(0);
    expect(d.offsetMeters).not.toBe(0);
    expect(d.urgent).toBe(true);
    expect(decideOvertake(base).urgent).toBe(false);
  });

  it("sees a parked car from far away at speed", () => {
    expect(
      decideOvertake({ ...base, gapMeters: 50, speedMs: 65, leaderSpeedMs: 0 }).attempt
    ).toBe(true);
    expect(
      decideOvertake({ ...base, gapMeters: 90, speedMs: 65, leaderSpeedMs: 0 }).attempt
    ).toBe(false);
  });
});

describe("slipstreamBonus", () => {
  it("pays only tucked behind on fast straights", () => {
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: true })).toBe(0.02);
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: false })).toBe(0);
    expect(slipstreamBonus({ gapMeters: 30, speedMs: 70, throttleZone: true })).toBe(0);
    expect(slipstreamBonus({ gapMeters: -5, speedMs: 70, throttleZone: true })).toBe(0);
  });
});

describe("followPaceScale", () => {
  it("matches the leader bumper-to-bumper but closes from distance", () => {
    // Same speed, tucked in: no reason to slow.
    expect(
      followPaceScale({ gapMeters: 3, throttleZone: true, aggression: 0.5, leaderSpeedMs: 60, ownSpeedMs: 60 })
    ).toBe(1);
    // Arriving hot: shed the closing speed, harder when closer.
    const far = followPaceScale({ gapMeters: 12, throttleZone: true, aggression: 0.5, leaderSpeedMs: 40, ownSpeedMs: 70 });
    const near = followPaceScale({ gapMeters: 4, throttleZone: true, aggression: 0.5, leaderSpeedMs: 40, ownSpeedMs: 70 });
    expect(far).toBeLessThan(1);
    expect(near).toBeLessThan(far);
    // Works in corners too, and ignores open road.
    expect(
      followPaceScale({ gapMeters: 5, throttleZone: false, aggression: 0.5, leaderSpeedMs: 30, ownSpeedMs: 45 })
    ).toBeLessThan(1);
    expect(
      followPaceScale({ gapMeters: 60, throttleZone: true, aggression: 0, leaderSpeedMs: 40, ownSpeedMs: 70 })
    ).toBe(1);
  });
});

describe("yieldPaceScale", () => {
  it("only cautious leaders give room when alongside", () => {
    expect(yieldPaceScale({ gapToFollowerMeters: 0, aggression: 0.9 })).toBe(1);
    expect(yieldPaceScale({ gapToFollowerMeters: 0, aggression: 0.1 })).toBeLessThan(1);
    expect(yieldPaceScale({ gapToFollowerMeters: 20, aggression: 0.1 })).toBe(1);
  });
});
