import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { getPitLane, PIT_SPEED_LIMIT_MS } from "../lib/tracks/pitLane";
import { AI_BOX_SPACING_METERS, buildPitPath, planPitLap, samplePath, startPitRun, stepPitRun } from "../lib/race/pitRun";

describe("AI pit stops", () => {
  it("only plan a stop in a long enough race, and never on the last lap", () => {
    expect(planPitLap(3, 5)).toBeNull();
    for (let laps = 5; laps <= 20; laps++) {
      for (let h = 0; h < 6; h++) {
        const lap = planPitLap(laps, h)!;
        expect(lap).toBeGreaterThanOrEqual(2);
        expect(lap).toBeLessThan(laps);
      }
    }
    expect(planPitLap(3, 0, 1)).toBe(1);
  });

  it("run the lane to the box, stop, wait, and leave at exit speed on every circuit with a lane", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const lane = getPitLane(track);
      if (!lane) continue;
      const n = track.centerline.length;
      const spacing = track.lengthMeters / n;
      // A car on the racing line 150 m before the entry.
      const startIndex = (lane.entryIndex - Math.round(150 / spacing) + n) % n;
      for (const slot of [0, 5, 15]) {
        const path = buildPitPath(track, lane, startIndex, 2, 0.7, slot);
        const run = startPitRun(80);
        let stopped = 0;
        let peakInLane = 0;
        for (let t = 0; t < 120 * 60 && !run.done; t++) {
          stepPitRun(run, path, 1 / 60, 3.2);
          if (run.phase === "stopped") stopped += 1 / 60;
          if (run.s >= 150 && run.s <= path.exitS) peakInLane = Math.max(peakInLane, run.v);
        }
        expect(run.done, `${meta.id} slot ${slot}`).toBe(true);
        expect(stopped).toBeGreaterThan(3.1);
        expect(peakInLane).toBeLessThanOrEqual(PIT_SPEED_LIMIT_MS + 0.01);
        // Ends up back near the centreline heading the right way.
        const end = samplePath(path, path.total);
        const c = track.centerline[(startIndex + path.cum.length - 1) % n];
        expect(Math.hypot(end.x - c[0], end.z - c[2])).toBeLessThan(2);
      }
    }
  });

  it("boxes are spread down the lane, and the path never jumps", () => {
    const track = getTrack("monza");
    const lane = getPitLane(track)!;
    const spacing = track.lengthMeters / track.centerline.length;
    const start = (lane.entryIndex - Math.round(150 / spacing) + track.centerline.length) % track.centerline.length;
    const a = buildPitPath(track, lane, start, 0, 0.7, 0);
    const b = buildPitPath(track, lane, start, 0, 0.7, 4);
    expect(a.boxS - b.boxS).toBeCloseTo(4 * AI_BOX_SPACING_METERS, 0);
    for (let k = 1; k < a.xs.length; k++) expect(Math.hypot(a.xs[k] - a.xs[k - 1], a.zs[k] - a.zs[k - 1])).toBeLessThan(6);
  });

  it("a car already inside the lane's stretch (a grid slot) joins it where it is", () => {
    for (const id of ["silverstone", "monza", "spa"]) {
      const track = getTrack(id);
      const lane = getPitLane(track)!;
      const n = track.centerline.length;
      const startIndex = (n - 10) % n; // about 30 m before the line: inside the span
      const path = buildPitPath(track, lane, startIndex, 0, 0.7, 3);
      const run = startPitRun(0);
      for (let t = 0; t < 120 * 60 && !run.done; t++) stepPitRun(run, path, 1 / 60, 3.2);
      expect(run.done, id).toBe(true);
      for (let k = 1; k < path.xs.length; k++) expect(Math.hypot(path.xs[k] - path.xs[k - 1], path.zs[k] - path.zs[k - 1])).toBeLessThan(6);
    }
  });
});
