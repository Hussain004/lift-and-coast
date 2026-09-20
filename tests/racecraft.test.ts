import { describe, expect, it } from "vitest";
import {
  composeRacePace,
  mergeOffsetFactor,
  obstacleLateral,
  squeezeDecision,
  decideOvertake,
  followPaceScale,
  slipstreamBonus,
  trackGapMeters,
  unwrapGap,
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
    expect(decideOvertake({ ...base, closingSpeedMs: 0.2 }).attempt).toBe(true);
    expect(decideOvertake({ ...base, closingSpeedMs: 0.1 }).attempt).toBe(false);

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

  it("needs a racing target: parked cars belong to the squeeze", () => {
    // A stopped car ahead is not a lunge (no closing ever builds) - the
    // squeeze below handles it. Proving the split: decideOvertake alone
    // refuses, compose with the obstacle squeezes.
    expect(decideOvertake({ ...base, gapMeters: 5, closingSpeedMs: 0 }).attempt).toBe(false);
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
    // ...and to a full stop behind a stopped car (which then unblocks
    // the squeeze to crawl around it).
    expect(
      followPaceScale({ gapMeters: 1, throttleZone: true, aggression: 0.5, leaderSpeedMs: 0, ownSpeedMs: 5 })
    ).toBe(0);
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
      ownSpeedMs: 67.6,
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
  // is perp*m with perp = (-dirZ, dirX) = (1, 0) - see pathFollower. A
  // positive lateral puts the obstacle on the +perp side, so the car goes
  // negative (away).
  const pref = { overtakeSide: 1 as const };

  it("goes around the side the obstacle is not on", () => {
    expect(squeezeDecision({ ...pref, lateralMeters: 2 })?.offsetMeters).toBe(-2.5);
    expect(squeezeDecision({ ...pref, lateralMeters: -2 })?.offsetMeters).toBe(2.5);
  });

  it("uses the preferred side dead ahead and ignores far-off obstacles", () => {
    expect(squeezeDecision({ ...pref, lateralMeters: 0.2 })?.offsetMeters).toBe(2.5);
    expect(squeezeDecision({ lateralMeters: 0.2, overtakeSide: -1 })?.offsetMeters).toBe(-2.5);
    expect(squeezeDecision({ ...pref, lateralMeters: 5 })).toBeNull();
  });
});

describe("obstacleLateral", () => {
  it("signs the across-track side in the line frame", () => {
    // Line down -Z: perp = (1, 0), so +X is positive lateral.
    expect(obstacleLateral(2, -5, 0, 0, 0, -1)).toBeCloseTo(2, 9);
    expect(obstacleLateral(-2, -5, 0, 0, 0, -1)).toBeCloseTo(-2, 9);
    expect(obstacleLateral(0, -5, 0, 0, 0, -1)).toBeCloseTo(0, 9);
  });
});

describe("compose squeeze", () => {
  const input = {
    ownSpeedMs: 8,
    rivals: [{ key: "lead", gapMeters: 5, speedMs: 0 }],
    throttleZone: true,
    cornerAheadMeters: 400,
    aggression: 0.5,
    risk: 0.3,
    overtakeSide: 1 as const,
    basePace: 1.0,
    alreadyAttemptingKey: null,
  };

  it("squeezes past a parked car at crawl pace without lunge pace", () => {
    const out = composeRacePace({
      ...input,
      obstacles: [{ gapMeters: 5, speedMs: 0, lateralMeters: 0.2 }],
    });
    expect(out.decision.attempt).toBe(true);
    expect(out.decision.urgent).toBe(true);
    expect(out.decision.paceBonus).toBe(0);
    expect(out.paceMult).toBeLessThan(0.2);
  });

  it("sees a parked car from far away at speed", () => {
    // The lead rival is far and moving (no lunge): only the obstacle
    // matters here.
    const openRoad = {
      ...input,
      rivals: [{ key: "lead", gapMeters: 60, speedMs: 60 }],
    };
    const far = composeRacePace({
      ...openRoad,
      ownSpeedMs: 65,
      obstacles: [{ gapMeters: 50, speedMs: 0, lateralMeters: 0 }],
    });
    expect(far.decision.attempt).toBe(true);
    expect(
      composeRacePace({
        ...openRoad,
        ownSpeedMs: 65,
        obstacles: [{ gapMeters: 90, speedMs: 0, lateralMeters: 0 }],
      }).decision.attempt
    ).toBe(false);
  });

  it("picks through a corner queue at crawl speed, not at racing speed", () => {
    const crawl = {
      ...input,
      ownSpeedMs: 10,
      throttleZone: false,
      obstacles: [{ gapMeters: 6, speedMs: 0, lateralMeters: 0 }],
    };
    expect(composeRacePace(crawl).decision.attempt).toBe(true);
    expect(composeRacePace({ ...crawl, ownSpeedMs: 50 }).decision.attempt).toBe(false);
  });

  it("ignores moving cars as obstacles", () => {
    const out = composeRacePace({
      ...input,
      obstacles: [{ gapMeters: 5, speedMs: 40, lateralMeters: 0 }],
    });
    expect(out.decision.urgent).toBe(false);
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

describe("unwrapGap", () => {
  const L = 5891;
  it("reads physical proximity across the start/finish seam", () => {
    // Car 8m behind the line (progress wraps near L) vs car on it.
    expect(unwrapGap(0, 5883, 0, 2, L)).toBeCloseTo(10, 6);
    expect(unwrapGap(0, 2, 0, 5883, L)).toBeCloseTo(-10, 6);
  });

  it("leaves normal gaps alone; lapped gaps wrap by design", () => {
    expect(unwrapGap(1, 100, 1, 150, L)).toBe(50);
    expect(unwrapGap(1, 150, 1, 100, L)).toBe(-50);
    // A full lap apart reads as coincident: safe because every consumer
    // is range- and speed-gated (a lapped car physically alongside IS an
    // imminent encounter; one far away is outside all windows).
    expect(unwrapGap(2, 100, 1, 100, L)).toBe(0);
  });
});
