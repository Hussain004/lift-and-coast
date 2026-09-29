import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { computeFloodlights, nearestLamps } from "../lib/tracks/floodlights";

describe("floodlights", () => {
  it("places a mast every ~90 m, clear of the track edge, on every circuit", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const lamps = computeFloodlights(track);
      expect(lamps.length, meta.id).toBeGreaterThan(track.lengthMeters / 160);
      expect(lamps.length, meta.id).toBeLessThan(track.lengthMeters / 60);
      for (const lamp of lamps) {
        // Never closer to the nearest centreline point than half a road plus the setback (minus slack for bends).
        let best = Infinity;
        let width = 12;
        track.centerline.forEach((c, i) => {
          const d = Math.hypot(c[0] - lamp.x, c[2] - lamp.z);
          if (d < best) {
            best = d;
            width = track.width[i] ?? 12;
          }
        });
        expect(best, meta.id).toBeGreaterThan(width / 2 + 4);
      }
    }
  });

  it("finds the nearest lamps, nearest first", () => {
    const lamps = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }, { x: 20, y: 0, z: 0 }];
    expect(nearestLamps(lamps, 15, 0, 2)).toEqual([2, 0]);
  });
});
