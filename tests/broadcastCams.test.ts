import { describe, expect, it } from "vitest";
import { buildBroadcastCams, selectBroadcastCam } from "../lib/race/broadcastCams";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";

describe("buildBroadcastCams", () => {
  for (const meta of TRACKS) {
    it(`${meta.id} gets full-lap elevated coverage on alternating sides`, () => {
      const track = getTrack(meta.id);
      const cams = buildBroadcastCams(track);
      // One every ~250m, at least six so short laps still cut around.
      expect(cams.length).toBeGreaterThanOrEqual(6);
      expect(cams.length).toBeLessThanOrEqual(Math.round(track.lengthMeters / 200) + 1);
      let left = 0;
      let right = 0;
      for (let k = 0; k < cams.length; k++) {
        const cam = cams[k];
        for (const v of [cam.x, cam.y, cam.z]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        // Eye above the ribbon, off to the side - never on the asphalt.
        // (Aim tracks the car live in Scene.tsx, so it isn't geometry here.)
        const i = Math.floor((k * track.centerline.length) / cams.length);
        const [cx, cy, cz] = track.centerline[i];
        expect(cam.y).toBeGreaterThan(cy + 5);
        expect(Math.hypot(cam.x - cx, cam.z - cz)).toBeGreaterThan(10);
        // Stations ordered around the lap.
        const expected = (i / track.centerline.length) * track.lengthMeters;
        expect(cam.progressMeters).toBeCloseTo(expected, 6);
        if (k % 2 === 0) right++;
        else left++;
      }
      expect(left).toBeGreaterThan(0);
      expect(right).toBeGreaterThan(0);
    });
  }
});

describe("selectBroadcastCam", () => {
  it("walks forward around the lap including the wrap", () => {
    const track = getTrack("silverstone");
    const cams = buildBroadcastCams(track);
    const L = track.lengthMeters;
    // Just behind the first station: the first camera is nearest ahead.
    expect(selectBroadcastCam(cams, 0, L)).toBe(0);
    // Just past it: the next one takes over.
    const mid = (cams[0].progressMeters + cams[1].progressMeters) / 2;
    expect(selectBroadcastCam(cams, cams[0].progressMeters + 1, L)).toBe(1);
    expect(selectBroadcastCam(cams, mid - 1, L)).toBe(1);
    // Past the final station the lap-line wrap hands back to camera 0.
    expect(selectBroadcastCam(cams, L - 1, L)).toBe(0);
  });
});
