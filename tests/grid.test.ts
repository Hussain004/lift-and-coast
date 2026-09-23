import { describe, expect, it } from "vitest";
import { GRID_BEHIND_METERS, SPAWN_CLEARANCE_METERS, gridSlot, groundElevationAt } from "../lib/race/grid";
import { getTrack } from "../lib/tracks/trackData";
import { checkTrackLimits } from "../lib/tracks/trackLimits";

const track = getTrack("silverstone");
const forward = {
  x: -Math.sin(track.startPos.headingRad),
  z: -Math.cos(track.startPos.headingRad),
};
const lateralOf = (s: { x: number; z: number }) =>
  (s.x - track.startPos.x) * -forward.z + (s.z - track.startPos.z) * forward.x;

describe("gridSlot", () => {
  it("puts pole at the line on the centerline", () => {
    const p1 = gridSlot(track, 0);
    expect(p1.x).toBeCloseTo(track.startPos.x, 9);
    expect(p1.z).toBeCloseTo(track.startPos.z, 9);
    expect(p1.startsBehindLine).toBe(false);
  });

  it("staggers P2 eight metres back on the offset column", () => {
    const p1 = gridSlot(track, 0);
    const p2 = gridSlot(track, 1);
    expect(p2.startsBehindLine).toBe(true);
    expect(p1.startsBehindLine).toBe(false);
    // The row is eight metres of centerline travel back, with a small local
    // lateral offset. On a curved start the straight-line projection is no
    // longer exact, so assert the physical row distance and track containment.
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeGreaterThan(GRID_BEHIND_METERS);
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeLessThan(GRID_BEHIND_METERS + 1);
    expect(lateralOf(p2)).toBeGreaterThan(0);
  });

  it("alternates columns by row down a full 20-car grid", () => {
    const slots = Array.from({ length: 20 }, (_, slot) => gridSlot(track, slot));
    // Rows pair up behind the line: slots 1-2 share row 1, 3-4 row 2...
    for (let row = 1; row <= 9; row++) {
      const a = slots[row * 2 - 1];
      const b = slots[row * 2];
      expect(a.startsBehindLine).toBe(true);
      expect(b.startsBehindLine).toBe(true);
      // Same row, opposite local columns. The exact x/z projection changes
      // as the centerline curves, so containment is the meaningful invariant.
      expect(lateralOf(a)).toBeGreaterThan(0);
      expect(lateralOf(b)).toBeLessThan(0);
      expect(checkTrackLimits(track, a.x, a.z, a.y).isOffTrack).toBe(false);
      expect(checkTrackLimits(track, b.x, b.z, b.y).isOffTrack).toBe(false);
      const previousA = row === 1 ? slots[0] : slots[(row - 1) * 2 - 1];
      const previousB = row === 1 ? slots[0] : slots[(row - 1) * 2];
      expect(Math.hypot(a.x - previousA.x, a.z - previousA.z)).toBeGreaterThan(7);
      expect(Math.hypot(b.x - previousB.x, b.z - previousB.z)).toBeGreaterThan(7);
    }
    // P20 sits furthest back and still on the grid.
    expect(Math.hypot(slots[19].x - slots[0].x, slots[19].z - slots[0].z)).toBeGreaterThan(70);
    expect(checkTrackLimits(track, slots[19].x, slots[19].z, slots[19].y).isOffTrack).toBe(false);
  });
});

describe("gridSlot elevation", () => {
  it("sits every slot on the surface, never at a flat height", () => {
    // Suzuka's final sector climbs ~2m across the grid: flat y=1 spawns
    // buried back-grid cars, grinding the solver into NaN (the frozen
    // 20-car Suzuka starts). Every slot reports ground + clearance.
    for (const id of ["silverstone", "suzuka"] as const) {
      const t = getTrack(id);
      for (let slot = 0; slot < 20; slot++) {
        const spawn = gridSlot(t, slot);
        expect(spawn.y - groundElevationAt(t, spawn.x, spawn.z)).toBeCloseTo(
          SPAWN_CLEARANCE_METERS,
          1
        );
        expect(checkTrackLimits(t, spawn.x, spawn.z, spawn.y).isOffTrack).toBe(false);
      }
    }
    const suzuka = getTrack("suzuka");
    const back = gridSlot(suzuka, 19);
    // The back row genuinely sits higher than pole here - a flat spawn
    // height would bury it.
    expect(back.y).toBeGreaterThan(gridSlot(suzuka, 0).y + 1);
  });

  it("keeps a full Hungaroring grid on the curved run to turn one", () => {
    const hungaroring = getTrack("budapest");
    for (let slot = 0; slot < 20; slot++) {
      const spawn = gridSlot(hungaroring, slot);
      expect(checkTrackLimits(hungaroring, spawn.x, spawn.z, spawn.y).isOffTrack).toBe(false);
    }
  });
});
