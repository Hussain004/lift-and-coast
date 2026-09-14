import { describe, expect, it } from "vitest";
import { createSectorTimer } from "../lib/race/sectorTimer";

// Two gates 100m apart along +x, both facing +x (headingRad chosen so
// forward = {x: -sin(heading), z: -cos(heading)} = {x: 1, z: 0}).
const FACING_PLUS_X = -Math.PI / 2;
const gateConfigs = [
  { x: 100, z: 0, headingRad: FACING_PLUS_X },
  { x: 200, z: 0, headingRad: FACING_PLUS_X },
];

/**
 * Drives through both gates for one lap, always including a sample
 * between gate 0's crossing and gate 1's line - the projection check needs
 * at least one "before" reading against a gate before it can register a
 * crossing, which real continuous driving always provides (gates are
 * ~2000m apart on a real track; no single physics step covers that), but
 * a synthetic test jumping straight from one gate's x-coordinate to the
 * next's would otherwise silently miss the second crossing.
 */
function driveLap(
  timer: ReturnType<typeof createSectorTimer>,
  startTime: number,
  gate0Time: number,
  gate1Time: number,
  eligible = true
) {
  timer.update(0, 0, startTime, eligible);
  const sector0 = timer.update(100, 0, gate0Time, eligible);
  timer.update(150, 0, (gate0Time + gate1Time) / 2, eligible);
  const sector1 = timer.update(200, 0, gate1Time, eligible);
  return [sector0, sector1] as const;
}

describe("createSectorTimer", () => {
  it("splits sector 1 and sector 2 on crossing each gate in order", () => {
    const timer = createSectorTimer(gateConfigs);
    const [sector0, sector1] = driveLap(timer, 0, 10, 20);

    expect(sector0).toEqual({ sectorIndex: 0, sectorSeconds: 10, color: "purple" });
    expect(sector1).toEqual({ sectorIndex: 1, sectorSeconds: 10, color: "purple" });
  });

  it("does not register a gate out of order (skipping ahead)", () => {
    const timer = createSectorTimer(gateConfigs);
    // Jump straight past both gates without a proper forward crossing of
    // gate 0 first (starts already past gate 0's line).
    const result = timer.update(250, 0, 1, true);
    expect(result).toBeNull();
  });

  it("classifies a first-ever pass as purple, a worse repeat as yellow, and a new session-best as purple again", () => {
    const timer = createSectorTimer(gateConfigs);

    const lap1 = driveLap(timer, 0, 10, 20);
    expect(lap1[0]?.color).toBe("purple");
    timer.onLapEnd(20, true, true); // new best lap - bestLapSectors becomes [10, 10]

    // Sector 1 at 12s - slower than both session-best (10) and best-lap
    // (10), so yellow.
    const lap2 = driveLap(timer, 0, 12, 24);
    expect(lap2[0]?.color).toBe("yellow");
    timer.onLapEnd(24, true, false); // not a new best lap - bestLapSectors unchanged

    // Sector 1 at 9s - a new session-best, so purple (not green).
    const lap3 = driveLap(timer, 0, 9, 20);
    expect(lap3[0]?.color).toBe("purple");
  });

  it("marks green when faster than the best lap's split but not the outright session-best", () => {
    const timer = createSectorTimer(gateConfigs);

    // Lap 1: 10s/10s, a new best lap - bestLapSectors becomes [10, 10].
    driveLap(timer, 0, 10, 20);
    timer.onLapEnd(20, true, true);

    // Lap 2: slow sector 1 (15s, yellow) but a blazing sector 2 (8s total,
    // 23-15) sets a new session-best for sector 2 - not a new best LAP
    // overall though (23s > 20s), so bestLapSectors stays [10, 10].
    const lap2 = driveLap(timer, 0, 15, 23);
    expect(lap2[0]?.color).toBe("yellow");
    expect(lap2[1]?.color).toBe("purple");
    timer.onLapEnd(23, true, false);

    // Lap 3: sector 2 at 9s (19-10) - slower than the session-best (8) so
    // not purple, but faster than the best lap's own sector-2 split (10).
    const lap3 = driveLap(timer, 0, 10, 19);
    expect(lap3[1]?.color).toBe("green");
  });

  it("gates a new session-best (purple) on eligibility, not on being numerically fastest", () => {
    const timer = createSectorTimer(gateConfigs);

    // Fastest possible time, but ineligible (e.g. a rewind happened this
    // lap) - must not become the session-best.
    const lap1 = driveLap(timer, 0, 5, 10, false);
    expect(lap1[0]?.color).toBe("yellow");
    timer.onLapEnd(10, false, false);

    // A later, slower-but-eligible lap should still be able to set purple,
    // since the ineligible lap's fast time was never recorded.
    const lap2 = driveLap(timer, 0, 8, 16, true);
    expect(lap2[0]?.color).toBe("purple");
  });

  it("only replaces the best-lap reference with a fully-formed set of splits", () => {
    const timer = createSectorTimer(gateConfigs);

    // A lap that skips gate 0 (starts already past it) produces only one
    // sector's worth of data - onLapEnd must not treat that partial array
    // as if index 0 were a real sector-1 time.
    const skipped = timer.update(250, 0, 1, true); // no crossing registered
    expect(skipped).toBeNull();
    const finalSplit = timer.onLapEnd(2, true, true);
    expect(finalSplit.sectorIndex).toBe(2);

    // The next, properly-driven lap's sector 1 should compare against a
    // real (still-null) best-lap reference, not a misaligned partial one.
    const [sector0] = driveLap(timer, 0, 20, 40);
    // No prior real sector-1 sample exists, so this can only be classified
    // by session-best (also unset) -> purple.
    expect(sector0?.color).toBe("purple");
  });

  it("reset clears in-progress gate state without recording anything", () => {
    const timer = createSectorTimer(gateConfigs);

    // Cross gate 0, then get teleported (simulating the off-track reset)
    // before reaching gate 1.
    timer.update(0, 0, 0, true);
    timer.update(100, 0, 10, true);
    timer.reset();

    // Driving from x=0 again, gate 0 must be expected again (not gate 1,
    // which nextGateIndex would still point at without the reset).
    const result = driveLap(timer, 0, 5, 15);
    expect(result[0]).toEqual({ sectorIndex: 0, sectorSeconds: 5, color: "purple" });
    expect(result[1]).toEqual({ sectorIndex: 1, sectorSeconds: 10, color: "purple" });
  });
});
