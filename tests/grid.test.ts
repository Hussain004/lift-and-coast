import { describe, expect, it } from "vitest";
import { GRID_BEHIND_METERS, gridSpawn } from "../lib/race/grid";
import { getTrack } from "../lib/tracks/trackData";

const track = getTrack("silverstone");

describe("gridSpawn", () => {
  it("keeps the historical equal-start spots with a null grid", () => {
    const player = gridSpawn(track, null, true);
    const ai = gridSpawn(track, null, false);
    expect(player.x).toBeCloseTo(track.startPos.x, 9);
    expect(player.z).toBeCloseTo(track.startPos.z, 9);
    expect(player.startsBehindLine).toBe(false);
    expect(ai.startsBehindLine).toBe(false);
    // AI keeps its lateral offset, player stays central.
    expect(Math.hypot(ai.x - track.startPos.x, ai.z - track.startPos.z)).toBeGreaterThan(0);
  });

  it("staggers P2 eight metres behind on the same lateral", () => {
    const p1 = gridSpawn(track, 1, true);
    const p2 = gridSpawn(track, 2, true);
    expect(p1.startsBehindLine).toBe(false);
    expect(p2.startsBehindLine).toBe(true);
    expect(Math.hypot(p2.x - p1.x, p2.z - p1.z)).toBeCloseTo(GRID_BEHIND_METERS, 6);
    const aiP1 = gridSpawn(track, 2, false);
    const aiP2 = gridSpawn(track, 1, false);
    expect(aiP1.startsBehindLine).toBe(false);
    expect(aiP2.startsBehindLine).toBe(true);
    // P2 behind, never ahead: it must travel further to the line.
    const forward = {
      x: -Math.sin(track.startPos.headingRad),
      z: -Math.cos(track.startPos.headingRad),
    };
    const along = (s: { x: number; z: number }) =>
      (s.x - track.startPos.x) * forward.x + (s.z - track.startPos.z) * forward.z;
    expect(along(p2)).toBeLessThan(along(p1));
  });
});
