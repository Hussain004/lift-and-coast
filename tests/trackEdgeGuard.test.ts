import { describe, expect, it } from "vitest";
import { trackEdgeSteerCorrection } from "../lib/ai/pathFollower";
import { buildTrackEdgeGuard, EDGE_GUARD_DISABLED_TRACK_IDS } from "../lib/ai/edgeGuard";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import { getTrack } from "../lib/tracks/trackData";
import { TRACKS } from "../lib/tracks/registry";

/**
 * Plan section 6, track-edge awareness.
 *
 * The controller is pure pursuit against the racing line and has no model of
 * where the track ENDS, so the AI's own worst excursion is the binding
 * constraint on how much run-off a circuit is allowed to leave. A
 * constant-gain cross-track correction was tried first and is documented as
 * closed in pathFollower.ts's header: always on, so it perturbs normal
 * driving, and its "safe" gains moved the worst excursion by ~2%.
 *
 * The guard in trackEdgeSteerCorrection is structurally different - exactly
 * zero unless the car is genuinely leaving the road, and quadratic in the
 * overshoot so it is C1-continuous where it starts. That is what lets it
 * carry real gain without the chaos, and these tests pin the properties that
 * make it safe rather than just its numbers.
 */
describe("trackEdgeSteerCorrection", () => {
  const FAST = 60;
  const SLOW = 5;

  it("is inert when no guard is supplied", () => {
    expect(trackEdgeSteerCorrection(undefined, FAST)).toBe(0);
  });

  it("is exactly zero with asphalt to spare, so normal driving is untouched", () => {
    // 5m of room on a 15m-wide track is comfortably on the racing line.
    expect(trackEdgeSteerCorrection({ roomMeters: 5, side: 1 }, FAST)).toBe(0);
    // The dead band ends one metre BEFORE the edge, not at it: the term is a
    // look-ahead, so a car still on the asphalt with room in hand gets
    // nothing and the reference law runs unchanged.
    expect(trackEdgeSteerCorrection({ roomMeters: 1, side: 1 }, FAST)).toBe(0);
    expect(trackEdgeSteerCorrection({ roomMeters: 1.01, side: 1 }, FAST)).toBe(0);
    // ...and it is continuous across that boundary: both value and slope are
    // zero there, so there is no step in the control law.
    const justInside = trackEdgeSteerCorrection({ roomMeters: 0.999, side: 1 }, FAST);
    expect(justInside).toBeGreaterThan(0);
    expect(justInside).toBeLessThan(0.001);
    expect(trackEdgeSteerCorrection({ roomMeters: 0, side: 1 }, FAST)).toBeCloseTo(0.22, 3);
  });

  it("is inert below the speed floor - a slow car resolves its own wide entry", () => {
    expect(trackEdgeSteerCorrection({ roomMeters: -4, side: 1 }, SLOW)).toBe(0);
    expect(trackEdgeSteerCorrection({ roomMeters: -4, side: 1 }, 25)).toBe(0);
  });

  it("steers back toward the centerline from whichever edge it is past", () => {
    // steer is positive = left (useDriveInput's input.steer convention), and
    // checkTrackLimits reports positive lateral for the right of the
    // centerline, so a car past the RIGHT edge must be pulled left.
    const right = trackEdgeSteerCorrection({ roomMeters: -3, side: 1 }, FAST);
    const left = trackEdgeSteerCorrection({ roomMeters: -3, side: -1 }, FAST);
    expect(right).toBeGreaterThan(0);
    expect(left).toBeLessThan(0);
    expect(Math.abs(right)).toBeCloseTo(Math.abs(left), 12);
  });

  it("grows quadratically with overshoot", () => {
    const at = (room: number) =>
      Math.abs(trackEdgeSteerCorrection({ roomMeters: room, side: 1 }, FAST));
    // Overshoot is measured from the activation distance, so it grows as the
    // car goes further past the edge.
    expect(at(0)).toBeLessThan(at(-1));
    expect(at(-1)).toBeLessThan(at(-3));
    expect(at(-3)).toBeLessThan(at(-8));
    // Overshoot 2 (room -1) against overshoot 4 (room -3) is exactly double,
    // and a quadratic term quadruples. A linear switch-on would only double
    // - this is the property that makes it C1-continuous at the boundary.
    expect(at(-3) / at(-1)).toBeCloseTo(4, 9);
  });

  it("ramps in over the speed schedule rather than switching on", () => {
    const at = (speed: number) =>
      Math.abs(trackEdgeSteerCorrection({ roomMeters: -3, side: 1 }, speed));
    expect(at(25)).toBe(0);
    expect(at(30)).toBeGreaterThan(0);
    expect(at(35)).toBeGreaterThan(at(30));
    // Fully scheduled by the ceiling, and capped there.
    expect(at(45)).toBeCloseTo(at(200), 12);
  });

  it("honours a per-call tuning override", () => {
    const gentle = trackEdgeSteerCorrection(
      { roomMeters: -3, side: 1, tuning: { gain: 0.01 } },
      FAST
    );
    const strong = trackEdgeSteerCorrection(
      { roomMeters: -3, side: 1, tuning: { gain: 0.4 } },
      FAST
    );
    expect(gentle).toBeLessThan(strong);
    // Activation distance moves the dead band: at 0.5m of room a wide
    // activation has already engaged, a tight one has not.
    const wide = trackEdgeSteerCorrection(
      { roomMeters: 0.5, side: 1, tuning: { activateMeters: 2 } },
      FAST
    );
    const tight = trackEdgeSteerCorrection(
      { roomMeters: 0.5, side: 1, tuning: { activateMeters: 0.25 } },
      FAST
    );
    expect(wide).toBeGreaterThan(0);
    expect(tight).toBe(0);
  });
});

describe("buildTrackEdgeGuard", () => {
  it("reports the room on the side the car is actually on", () => {
    const track = getTrack("silverstone");
    // A point on the centerline should have the full half-width to spare.
    const center = track.centerline[100];
    const onLine = buildTrackEdgeGuard(track, center[0], center[2], center[1])!;
    expect(onLine).toBeDefined();
    const half = track.width[100] / 2;
    expect(onLine.roomMeters).toBeCloseTo(half, 6);
    expect(Math.abs(onLine.side)).toBe(1);
  });

  it("goes negative once the car is past the edge", () => {
    const track = getTrack("silverstone");
    const i = 100;
    const c = track.centerline[i];
    const before = track.centerline[i - 1];
    const after = track.centerline[i + 1];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const len = Math.hypot(tx, tz) || 1;
    const rightX = -tz / len;
    const rightZ = tx / len;
    // 3m beyond the right-hand edge.
    const offset = track.width[i] / 2 + 3;
    const guard = buildTrackEdgeGuard(track, c[0] + rightX * offset, c[2] + rightZ * offset, c[1])!;
    expect(guard.roomMeters).toBeCloseTo(-3, 3);
    expect(guard.side).toBe(1);
  });

  it("is undefined on the circuits where the guard is disabled", () => {
    // Suzuka: see EDGE_GUARD_DISABLED_TRACK_IDS for the measured reason.
    expect(EDGE_GUARD_DISABLED_TRACK_IDS.has("suzuka")).toBe(true);
    const track = getTrack("suzuka");
    const c = track.centerline[50];
    expect(buildTrackEdgeGuard(track, c[0], c[2], c[1])).toBeUndefined();
  });

  it("agrees with the track-limit scan it is handed", () => {
    const track = getTrack("monza");
    const c = track.centerline[200];
    const status = checkTrackLimits(track, c[0], c[2], c[1]);
    const reused = buildTrackEdgeGuard(track, c[0], c[2], c[1], status)!;
    const fresh = buildTrackEdgeGuard(track, c[0], c[2], c[1])!;
    expect(reused.roomMeters).toBeCloseTo(fresh.roomMeters, 12);
    expect(reused.side).toBe(fresh.side);
  });

  it("enables every other registered circuit", () => {
    for (const { id } of TRACKS) {
      const track = getTrack(id);
      const c = track.centerline[0];
      const guard = buildTrackEdgeGuard(track, c[0], c[2], c[1]);
      if (EDGE_GUARD_DISABLED_TRACK_IDS.has(id)) expect(guard).toBeUndefined();
      else expect(guard).toBeDefined();
    }
  });
});
