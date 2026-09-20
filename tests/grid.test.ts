import { describe, expect, it } from "vitest";
import { GRID_BEHIND_METERS, SPAWN_CLEARANCE_METERS, gridSlot, groundElevationAt } from "../lib/race/grid";
import { getTrack } from "../lib/tracks/trackData";

const track = getTrack("silverstone");
const forward = {
  x: -Math.sin(track.startPos.headingRad),
  z: -Math.cos(track.startPos.headingRad),
};
const along = (s: { x: number; z: number }) =>
  (s.x - track.startPos.x) * forward.x + (s.z - track.startPos.z) * forward.z;
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
    // Eight metres back along the direction of travel (hypot includes the
    // lateral column offset, so measure along the track instead).
    expect(along(p1) - along(p2)).toBeCloseTo(GRID_BEHIND_METERS, 6);
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
      // Same row, opposite columns, same distance back.
      expect(lateralOf(a)).toBeGreaterThan(0);
      expect(lateralOf(b)).toBeLessThan(0);
      expect(along(a)).toBeCloseTo(-row * GRID_BEHIND_METERS, 6);
      expect(along(b)).toBeCloseTo(-row * GRID_BEHIND_METERS, 6);
    }
    // P20 sits furthest back and still on the grid.
    expect(along(slots[19])).toBeCloseTo(-10 * GRID_BEHIND_METERS, 6);
    // Strictly non-increasing distance back down the order (pole first).
    for (let slot = 1; slot < 20; slot++) {
      expect(along(slots[slot])).toBeLessThanOrEqual(along(slots[slot - 1]) + 1e-9);
    }
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
          9
        );
      }
    }
    const suzuka = getTrack("suzuka");
    const back = gridSlot(suzuka, 19);
    // The back row genuinely sits higher than pole here - a flat spawn
    // height would bury it.
    expect(back.y).toBeGreaterThan(gridSlot(suzuka, 0).y + 1);
  });
});
