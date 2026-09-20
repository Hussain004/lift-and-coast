import { describe, expect, it } from "vitest";
import {
  composeRacePace,
  mergeOffsetFactor,
  squeezeDecision,
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
    alreadyAttempting: false,
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
    expect(decideOvertake({ ...base, cornerAheadMeters: 60, risk: 0.9 }).attempt).toBe(true);
    expect(decideOvertake({ ...base, cornerAheadMeters: 60, risk: 0 }).attempt).toBe(false);
  });

  it("fires on a whisper of closing and latches past the gate", () => {
    expect(decideOvertake({ ...base, closingSpeedMs: 0.4 }).attempt).toBe(true);
    expect(decideOvertake({ ...base, closingSpeedMs: 0.2 }).attempt).toBe(false);

    // The follow discipline kills closing speed on approach: without the
    // latch the attempt would die the same tick it starts.
    const stalled = decideOvertake({ ...base, closingSpeedMs: 0.1, alreadyAttempting: true });
    expect(stalled.attempt).toBe(true);
    expect(decideOvertake({ ...base, closingSpeedMs: 0.1 }).attempt).toBe(false);
    // ...but clears once the pass sticks, the road ends, or the zone flips.
    expect(decideOvertake({ ...base, gapMeters: -5, alreadyAttempting: true }).attempt).toBe(false);
    expect(decideOvertake({ ...base, throttleZone: false, alreadyAttempting: true }).attempt).toBe(false);
    expect(
      decideOvertake({ ...base, cornerAheadMeters: 10, alreadyAttempting: true }).attempt
    ).toBe(false);
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

  it("picks through a corner queue at crawl speed", () => {
    const crawl = { ...base, gapMeters: 6, speedMs: 10, leaderSpeedMs: 0, throttleZone: false };
    const d = decideOvertake(crawl);
    expect(d.attempt).toBe(true);
    expect(d.urgent).toBe(true);
    // ...but not at racing speed mid-corner: that way lies the grandstand.
    expect(decideOvertake({ ...crawl, speedMs: 50 }).attempt).toBe(false);
  });
});

describe("slipstreamBonus", () => {
  it("pays only tucked behind on fast straights", () => {
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: true })).toBe(0.035);
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: false })).toBe(0);
    expect(slipstreamBonus({ gapMeters: 30, speedMs: 70, throttleZone: true })).toBe(0);
    expect(slipstreamBonus({ gapMeters: -5, speedMs: 70, throttleZone: true })).toBe(0);
  });
});

describe("followPaceScale", () => {
  it("backs out of a nose-to-tail weld instead of matching", () => {
    const welded = followPaceScale({ gapMeters: 1.8, throttleZone: true, aggression: 0.5, leaderSpeedMs: 60, ownSpeedMs: 60 });
    expect(welded).toBeLessThan(1);
    expect(welded).toBeGreaterThanOrEqual(0.3);
    // ...but never below a crawl that strands the car.
    expect(
      followPaceScale({ gapMeters: 1, throttleZone: true, aggression: 0.5, leaderSpeedMs: 0, ownSpeedMs: 5 })
    ).toBeGreaterThanOrEqual(0.3);
  });

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

describe("composeRacePace", () => {
  const input = {
    ownSpeedMs: 70,
    rivals: [
      { key: "lead", gapMeters: 8, speedMs: 67 },
      { key: "tail", gapMeters: -50, speedMs: 60 },
    ],
    throttleZone: true,
    cornerAheadMeters: 300,
    aggression: 0.6,
    risk: 0.3,
    overtakeSide: 1 as const,
    basePace: 1.0,
    alreadyAttemptingKey: null,
  };

  it("stacks slipstream and lunge bonus on an attempt", () => {
    const out = composeRacePace(input);
    expect(out.decision.attempt).toBe(true);
    expect(out.paceMult).toBeGreaterThan(1.03);
  });

  it("stands the follow discipline down mid-pass", () => {    // Closing decayed mid-pass (the follow discipline's own doing): the
    // latch keeps the move alive at full pace plus bonus, while the same
    // scene unlatched queues with the follow trim applied.
    const scene = {
      ...input,
      rivals: [{ key: "lead", gapMeters: 1, speedMs: 67.5 }],
      ownSpeedMs: 67.7,
    };
    const passing = composeRacePace({ ...scene, alreadyAttemptingKey: "lead" });
    const queued = composeRacePace({ ...scene, alreadyAttemptingKey: null });
    expect(passing.decision.attempt).toBe(true);
    expect(queued.decision.attempt).toBe(false);
    // Latched: slipstream + lunge bonus, zero follow drag.
    expect(passing.paceMult).toBeCloseTo(1 + 0.035 + 0.015 + 0.6 * 0.015, 6);
    // Queued: same slipstream, minus the follow trim.
    expect(queued.paceMult).toBeLessThan(1.035);
    expect(queued.paceMult).toBeLessThan(passing.paceMult);
  });

  it("holds the leader's pace bumper-to-bumper in corners", () => {
    const out = composeRacePace({
      ...input,
      throttleZone: false,
      rivals: [{ key: "lead", gapMeters: 3, speedMs: 30 }],
      ownSpeedMs: 45,
    });
    expect(out.decision.attempt).toBe(false);
    expect(out.paceMult).toBeLessThan(1);
  });
});

describe("squeezeDecision", () => {
  // Straight line down -Z (line frame): the pursuit shift for an offset m
  // is perp*m with perp = (-dirZ, dirX) = (1, 0) - see pathFollower.
  const line = { lineX: 0, lineZ: 0, lineDirX: 0, lineDirZ: -1, overtakeSide: 1 as const };

  it("goes around the side the obstacle is not on", () => {
    const right = squeezeDecision({ ...line, obstacleX: 2, obstacleZ: -5 });
    expect(right?.offsetMeters).toBeLessThan(0);
    // Pursuit point lands on the opposite side from the obstacle.
    expect(right!.offsetMeters * 1 + 2).toBeLessThan(0.01);
    const left = squeezeDecision({ ...line, obstacleX: -2, obstacleZ: -5 });
    expect(left?.offsetMeters).toBeGreaterThan(0);
  });

  it("uses the preferred side dead ahead and ignores far-off obstacles", () => {
    expect(squeezeDecision({ ...line, obstacleX: 0.2, obstacleZ: -5 })?.offsetMeters).toBe(2.5);
    expect(
      squeezeDecision({ ...line, obstacleX: 0.2, obstacleZ: -5, overtakeSide: -1 })?.offsetMeters
    ).toBe(-2.5);
    expect(squeezeDecision({ ...line, obstacleX: 5, obstacleZ: -5 })).toBeNull();
  });
});

describe("target-keyed latch", () => {
  const base = {
    ownSpeedMs: 70,
    throttleZone: true,
    cornerAheadMeters: 300,
    aggression: 0.6,
    risk: 0.3,
    overtakeSide: 1 as const,
    basePace: 1.0,
  };

  it("survives the target wobbling a meter behind mid-pass", () => {
    const wobble = composeRacePace({
      ...base,
      rivals: [
        { key: "mark", gapMeters: -1.5, speedMs: 69 },
        { key: "next", gapMeters: 25, speedMs: 70 },
      ],
      alreadyAttemptingKey: "mark",
    });
    expect(wobble.decision.attempt).toBe(true);
    expect(wobble.attemptKey).toBe("mark");
    // ...but lets go once clearly beaten, re-targeting the road ahead.
    const beaten = composeRacePace({
      ...base,
      rivals: [
        { key: "mark", gapMeters: -8, speedMs: 69 },
        { key: "next", gapMeters: 25, speedMs: 70 },
      ],
      alreadyAttemptingKey: "mark",
    });
    expect(beaten.decision.attempt).toBe(false);
    expect(beaten.attemptKey).toBeNull();
  });
});

describe("mergeOffsetFactor", () => {
  it("holds full offset astern and washes out as the nose clears", () => {
    expect(mergeOffsetFactor(10)).toBe(1);
    expect(mergeOffsetFactor(0)).toBe(1);
    expect(mergeOffsetFactor(-1)).toBeCloseTo(0.75, 9);
    expect(mergeOffsetFactor(-4)).toBe(0);
    expect(mergeOffsetFactor(-10)).toBe(0);
  });
});
