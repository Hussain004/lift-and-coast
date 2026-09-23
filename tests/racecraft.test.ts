import { describe, expect, it } from "vitest";
import {
  AERO_STRAIGHT_ENTER_METERS,
  AERO_STRAIGHT_EXIT_METERS,
  chooseAeroMode,
  createRacecraftState,
  followGapMeters,
  followSpeedCapMs,
  lateralBand,
  obstacleLateral,
  shouldDeployBoost,
  slipstreamBonus,
  stepRacecraft,
  trackGapMeters,
  unwrapGap,
  type FieldCarView,
  type LineContext,
  type RacecraftInput,
  type RacecraftState,
} from "../lib/ai/racecraft";
import { computeLineRoom } from "../lib/tracks/racingLineCache";
import { computeRacingLine } from "../lib/tracks/racingLine";
import type { TrackData } from "../lib/tracks/types";

const TRACK = 5891;

describe("chooseAeroMode", () => {
  const straight = (cornerAheadMeters: number) => ({
    throttleZone: true,
    cornerAheadMeters,
    curveSign: 0 as const,
  });

  it("deploys low drag only on a clear, fast straight", () => {
    expect(
      chooseAeroMode({
        current: "high-downforce",
        line: straight(AERO_STRAIGHT_ENTER_METERS),
        speedMs: 45,
        attempting: false,
        blocked: false,
      })
    ).toBe("low-drag");
    expect(
      chooseAeroMode({
        current: "high-downforce",
        line: straight(100),
        speedMs: 45,
        attempting: false,
        blocked: false,
      })
    ).toBe("high-downforce");
  });

  it("uses hysteresis and protects grip during attacks, blocks and corners", () => {
    expect(
      chooseAeroMode({
        current: "low-drag",
        line: straight(AERO_STRAIGHT_EXIT_METERS - 1),
        speedMs: 45,
        attempting: false,
        blocked: false,
      })
    ).toBe("high-downforce");
    expect(
      chooseAeroMode({
        current: "low-drag",
        line: straight(300),
        speedMs: 45,
        attempting: true,
        blocked: false,
      })
    ).toBe("high-downforce");
    expect(
      chooseAeroMode({
        current: "low-drag",
        line: { ...straight(300), curveSign: 1 },
        speedMs: 45,
        attempting: false,
        blocked: false,
      })
    ).toBe("high-downforce");
  });
});

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

describe("slipstreamBonus", () => {
  it("pays only tucked behind on fast straights", () => {
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: true })).toBe(0.05);
    expect(slipstreamBonus({ gapMeters: 10, speedMs: 70, throttleZone: false })).toBe(0);
    expect(slipstreamBonus({ gapMeters: 45, speedMs: 70, throttleZone: true })).toBe(0);
    expect(slipstreamBonus({ gapMeters: -5, speedMs: 70, throttleZone: true })).toBe(0);
    // The tow reaches out far and low: mid-speeds and 30m gaps still get
    // the run that delivers a car into lunge range.
    expect(slipstreamBonus({ gapMeters: 30, speedMs: 40, throttleZone: true })).toBe(0.05);
    expect(slipstreamBonus({ gapMeters: 30, speedMs: 30, throttleZone: true })).toBe(0);
  });

  describe("shouldDeployBoost", () => {
    it("only deploys where boost can actually carry speed", () => {
      const base = { boostEligible: true, batteryFraction: 1, aggression: 0.9, attemptingLunge: false };
      expect(shouldDeployBoost(base)).toBe(true);
      expect(shouldDeployBoost({ ...base, boostEligible: false })).toBe(false);
    });

    it("dumps the battery on a lunge, banks it while cautious", () => {
      const base = { boostEligible: true, batteryFraction: 0.2, aggression: 0.2, attemptingLunge: false };
      // Cautious metronome: saves the harvest for the one move that matters.
      expect(shouldDeployBoost(base)).toBe(false);
      // ...but hand it a live pass and everything goes in.
      expect(shouldDeployBoost({ ...base, attemptingLunge: true })).toBe(true);
      expect(shouldDeployBoost({ ...base, attemptingLunge: true, batteryFraction: 0.04 })).toBe(false);
    });

    it("spends freely as aggression rises", () => {
      const mid = { boostEligible: true, batteryFraction: 0.6, aggression: 0.5, attemptingLunge: false };
      const diver = { ...mid, aggression: 0.9 };
      // Mid-aggression deploys above ~0.725 charge, a dive-bomber above ~0.5.
      expect(shouldDeployBoost(mid)).toBe(false);
      expect(shouldDeployBoost(diver)).toBe(true);
    });
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


describe("following", () => {
  it("stops at a standoff behind a stopped car, with room to steer round it", () => {
    // Far out at racing speed: no cap yet worth having.
    expect(followSpeedCapMs(200, 0, followGapMeters(70, 0.5, false, 0))).toBeGreaterThan(55);
    // Closer in, the cap is a braking curve down to zero at the standoff.
    const standoff = followGapMeters(0, 0.5, false, 0);
    expect(standoff).toBeGreaterThanOrEqual(12);
    expect(followSpeedCapMs(standoff, 0, standoff)).toBe(0);
    expect(followSpeedCapMs(standoff - 2, 0, standoff)).toBe(0);
  });

  it("sits at a time gap behind a moving car, closer for the brave", () => {
    const cautious = followGapMeters(70, 0, false);
    const brave = followGapMeters(70, 1, false);
    expect(cautious).toBeGreaterThan(brave);
    expect(brave).toBeGreaterThan(7);
    // At the gap the cap is the leader's own speed; beyond it, faster.
    expect(followSpeedCapMs(brave, 60, brave)).toBeCloseTo(60, 6);
    expect(followSpeedCapMs(brave + 10, 60, brave)).toBeGreaterThan(61);
    // An attacker closing on its own target runs almost to its gearbox.
    expect(followGapMeters(70, 0.5, true)).toBeLessThan(7);
  });
});

describe("lateralBand", () => {
  const room = { roomPlusMeters: 5, roomMinusMeters: 5 };
  const car = (gapMeters: number, lateralMeters: number | null): FieldCarView => ({
    key: `c${gapMeters}:${lateralMeters}`,
    gapMeters,
    speedMs: 50,
    lateralMeters,
  });

  it("closes the road on each overlapping car's side", () => {
    const band = lateralBand({ ownLateralMeters: 0, cars: [car(1, 2.6), car(-2, -3)], ...room });
    expect(band.hi).toBeCloseTo(0.1, 6);
    expect(band.lo).toBeCloseTo(-0.5, 6);
  });

  it("ignores cars clear ahead/behind, unknown positions and bumper queues", () => {
    const band = lateralBand({
      ownLateralMeters: 0,
      cars: [car(8, 0.5), car(-7, 1), car(2, null), car(4.5, 0.3)],
      ...room,
    });
    expect(band).toEqual({ lo: -5, hi: 5 });
  });

  it("reports a sandwich as lo > hi", () => {
    const band = lateralBand({ ownLateralMeters: 0, cars: [car(0, 2), car(1, -2)], ...room });
    expect(band.lo).toBeGreaterThan(band.hi);
  });
});

describe("stepRacecraft", () => {
  const line = (overrides: Partial<LineContext> = {}): LineContext => ({
    cornerAheadMeters: 400,
    throttleZone: true,
    roomPlusMeters: 4,
    roomMinusMeters: 4,
    cornerSign: 0,
    curveSign: 0,
    impliedRadiusMeters: Infinity,
    profileTargetMs: 70,
    ...overrides,
  });
  const input = (overrides: Partial<RacecraftInput> = {}): RacecraftInput => ({
    ownSpeedMs: 60,
    ownLateralMeters: 0,
    basePace: 1,
    cars: [],
    line: line(),
    aggression: 0.6,
    risk: 0.3,
    overtakeSide: 1,
    dt: 1 / 60,
    trackLengthMeters: TRACK,
    boostEligible: false,
    batteryFraction: 1,
    mistakeActive: false,
    ...overrides,
  });
  const racingState = (): RacecraftState => ({ ...createRacecraftState(), initialized: true, raceSeconds: 30 });
  const run = (state: RacecraftState, make: () => RacecraftInput, seconds: number) => {
    let out = stepRacecraft(state, make());
    for (let t = 1 / 60; t < seconds; t += 1 / 60) out = stepRacecraft(state, make());
    return out;
  };

  it("keeps each grid column in its own lane until the lights go out", () => {
    const state = createRacecraftState();
    stepRacecraft(state, input({ ownSpeedMs: 0, ownLateralMeters: 2.3 }));
    run(state, () => input({ ownSpeedMs: 0, ownLateralMeters: 2.3 }), 2);
    expect(state.offset).toBeCloseTo(2.3, 6);
  });

  it("brakes to a stop for a stopped car in its lane", () => {
    const state = racingState();
    const out = stepRacecraft(
      state,
      input({ ownSpeedMs: 30, cars: [{ key: "x", gapMeters: 25, speedMs: 0, lateralMeters: 0.4 }] })
    );
    expect(out.paceMult).toBeLessThan(0.4);
  });

  it("does not queue behind a car in the next lane", () => {
    const state = racingState();
    const out = stepRacecraft(
      state,
      input({ ownSpeedMs: 60, cars: [{ key: "x", gapMeters: 12, speedMs: 50, lateralMeters: 2.8 }] })
    );
    expect(out.paceMult).toBeGreaterThanOrEqual(1);
  });

  it("goes round a stopped car on the side with road", () => {
    const state = racingState();
    run(
      state,
      () =>
        input({
          ownSpeedMs: 40,
          line: line({ roomPlusMeters: 0.5, roomMinusMeters: 5 }),
          cars: [{ key: "x", gapMeters: 50, speedMs: 0, lateralMeters: 0 }],
        }),
      2
    );
    expect(state.offset).toBeLessThan(-2);
  });

  it("attacks on the side with room, toward the inside of the next corner", () => {
    const leader: FieldCarView = { key: "lead", gapMeters: 12, speedMs: 55, lateralMeters: 0 };
    const inside = racingState();
    stepRacecraft(inside, input({ cars: [leader], line: line({ cornerSign: -1, cornerAheadMeters: 250 }) }));
    expect(inside.attemptKey).toBe("lead");
    expect(inside.attemptSide).toBe(-1);
    // No room on that side: the other one, whatever the corner says.
    const cramped = racingState();
    stepRacecraft(
      cramped,
      input({ cars: [leader], line: line({ cornerSign: -1, cornerAheadMeters: 250, roomMinusMeters: 0.5 }) })
    );
    expect(cramped.attemptSide).toBe(1);
  });

  it("never picks a side somebody is already sitting in", () => {
    const state = racingState();
    stepRacecraft(
      state,
      input({
        cars: [
          { key: "lead", gapMeters: 12, speedMs: 55, lateralMeters: 0 },
          { key: "beside", gapMeters: 1, speedMs: 60, lateralMeters: 2.8 },
        ],
      })
    );
    expect(state.attemptSide).toBe(-1);
  });

  it("never turns into a car alongside, even to defend or to take the line", () => {
    const state = racingState();
    state.offset = 0;
    // A car on our +side, overlapping: the line (0) is fine, crossing past
    // its band is not - even with the inside of the corner on that side.
    run(
      state,
      () =>
        input({
          ownLateralMeters: state.offset,
          line: line({ cornerSign: 1, cornerAheadMeters: 150 }),
          cars: [
            { key: "beside", gapMeters: 0.5, speedMs: 60, lateralMeters: 1.8 },
            { key: "chaser", gapMeters: -10, speedMs: 64, lateralMeters: 0 },
          ],
        }),
      3
    );
    expect(state.offset).toBeLessThanOrEqual(1.8 - 2.5 + 1e-6);
  });

  it("defends the inside once, on a straight, against a quicker car", () => {
    const state = racingState();
    run(
      state,
      () =>
        input({
          ownLateralMeters: state.offset,
          line: line({ cornerSign: 1, cornerAheadMeters: 150 }),
          cars: [{ key: "chaser", gapMeters: -10, speedMs: 64, lateralMeters: 0 }],
        }),
      2
    );
    expect(state.defendKey).toBe("chaser");
    expect(state.offset).toBeGreaterThan(1);
  });

  it("dives down the inside at the braking zone from close behind", () => {
    const state = racingState();
    stepRacecraft(
      state,
      input({
        ownSpeedMs: 50,
        aggression: 0.8,
        line: line({ throttleZone: false, cornerSign: 1, cornerAheadMeters: 5 }),
        cars: [{ key: "lead", gapMeters: 7, speedMs: 48, lateralMeters: 0 }],
      })
    );
    expect(state.attemptKey).toBe("lead");
    expect(state.attemptSide).toBe(1);
    // A cautious driver, or one too far back, stays put.
    const cautious = racingState();
    stepRacecraft(
      cautious,
      input({
        ownSpeedMs: 50,
        aggression: 0.2,
        line: line({ throttleZone: false, cornerSign: 1, cornerAheadMeters: 5 }),
        cars: [{ key: "lead", gapMeters: 7, speedMs: 48, lateralMeters: 0 }],
      })
    );
    expect(cautious.attemptKey).toBeNull();
  });

  it("flags Manual Override within a second of the car ahead", () => {
    const close = stepRacecraft(
      racingState(),
      input({ ownSpeedMs: 60, cars: [{ key: "a", gapMeters: 40, speedMs: 60, lateralMeters: 0 }] })
    );
    expect(close.override).toBe(true);
    const far = stepRacecraft(
      racingState(),
      input({ ownSpeedMs: 60, cars: [{ key: "a", gapMeters: 90, speedMs: 60, lateralMeters: 0 }] })
    );
    expect(far.override).toBe(false);
  });

  it("gives a lapping car the road", () => {
    const state = racingState();
    const out = run(
      state,
      () =>
        input({
          ownLateralMeters: state.offset,
          cars: [{ key: "leader", gapMeters: -20, rawGapMeters: TRACK - 20, speedMs: 65, lateralMeters: 0 }],
        }),
      2
    );
    expect(Math.abs(state.offset)).toBeGreaterThan(1);
    expect(out.paceMult).toBeLessThan(1);
  });
});

describe("computeLineRoom corner sign", () => {
  // A stadium (two 300m straights, two 60m-radius semicircles): the only
  // corners are the semicircles, so every point shortly before one must
  // name the side the semicircle's centre lies on as the inside. Both
  // directions of travel, so the convention can't be right by accident.
  function stadium(reverse: boolean): TrackData {
    const pts: [number, number, number][] = [];
    const straight = 300;
    const r = 60;
    const step = 2;
    for (let s = 0; s < straight; s += step) pts.push([s, 0, 0]);
    for (let a = 0; a < Math.PI; a += step / r) pts.push([straight + r * Math.sin(a), 0, r - r * Math.cos(a)]);
    for (let s = straight; s > 0; s -= step) pts.push([s, 0, 2 * r]);
    for (let a = 0; a < Math.PI; a += step / r) pts.push([-r * Math.sin(a), 0, r + r * Math.cos(a)]);
    if (reverse) pts.reverse();
    const length = pts.reduce((sum, p, i) => {
      const q = pts[(i + 1) % pts.length];
      return sum + Math.hypot(q[0] - p[0], q[2] - p[2]);
    }, 0);
    return {
      id: "stadium",
      name: "stadium",
      lengthMeters: length,
      centerline: pts,
      width: pts.map(() => 12),
      startPos: { x: pts[0][0], z: pts[0][2], headingRad: 0 },
    };
  }

  for (const reverse of [false, true]) {
    it(`points at the corner centre (${reverse ? "reversed" : "forward"})`, () => {
      const track = stadium(reverse);
      const line = computeRacingLine(track);
      const room = computeLineRoom(track, line);
      const n = line.length;
      let checked = 0;
      for (let i = 0; i < n; i++) {
        const p = track.centerline[i];
        // Straight segments only, well clear of either end.
        const onStraight = (p[2] === 0 || p[2] === 120) && p[0] > 60 && p[0] < 240;
        if (!onStraight) continue;
        const q = track.centerline[(i + 1) % n];
        const dx = q[0] - p[0];
        const dz = q[2] - p[2];
        const len = Math.hypot(dx, dz);
        // Heading toward the semicircle at x=300 (centre z=60) or at x=0.
        const centre = dx > 0 ? [300, 60] : [0, 60];
        const side = Math.sign((centre[0] - p[0]) * (-dz / len) + (centre[1] - p[2]) * (dx / len));
        expect(room.cornerSign[i]).toBe(side);
        checked++;
      }
      expect(checked).toBeGreaterThan(100);
    });
  }
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
