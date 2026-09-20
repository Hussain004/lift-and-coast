import { describe, expect, it } from "vitest";
import { createProgressTracker, trackProgress } from "../lib/race/progressTracker";
import { getTrack } from "../lib/tracks/trackData";

const track = getTrack("silverstone");
const n = track.centerline.length;

function pointAt(frac: number): [number, number] {
  const p = track.centerline[Math.floor(frac * n) % n];
  return [p[0], p[2]];
}

describe("trackProgress", () => {
  it("matches the scan contract away from the seam", () => {
    const tracker = createProgressTracker();
    const [x, z] = pointAt(0.25);
    const { progressMeters } = trackProgress(track, x, z, tracker);
    expect(progressMeters).toBeCloseTo(0.25 * track.lengthMeters, -1);
  });

  it("never flickers for a car sitting on the seam", () => {
    const tracker = createProgressTracker();
    const at = (frac: number): number => {
      const [x, z] = pointAt(frac);
      return trackProgress(track, x, z, tracker).progressMeters;
    };
    // Settle on either side first, then sit exactly on the line.
    at(0.999);
    const first = at(0.0);
    const second = at(0.0);
    const third = at(0.0);
    expect(Math.abs(first - second)).toBeLessThan(1);
    expect(Math.abs(second - third)).toBeLessThan(1);
  });

  it("crosses the line continuously in both directions", () => {
    const tracker = createProgressTracker();
    const samples: number[] = [];
    for (let k = -5; k <= 5; k++) {
      const frac = ((Math.floor(0.999 * n) + k) % n) / n;
      const [x, z] = pointAt(frac);
      samples.push(trackProgress(track, x, z, tracker).progressMeters);
    }
    // Unwrapped step-to-step deltas stay small: the line crossing reads
    // as a wrap (correct), never as a mid-lap teleport.
    for (let k = 1; k < samples.length; k++) {
      let step = samples[k] - samples[k - 1];
      if (step < -track.lengthMeters / 2) step += track.lengthMeters;
      if (step > track.lengthMeters / 2) step -= track.lengthMeters;
      expect(Math.abs(step)).toBeLessThan(50);
    }
  });

  it("re-seeds globally after a teleport", () => {
    const tracker = createProgressTracker();
    const [x0, z0] = pointAt(0.1);
    trackProgress(track, x0, z0, tracker);
    const [x1, z1] = pointAt(0.7);
    const out = trackProgress(track, x1, z1, tracker);
    expect(out.teleported).toBe(true);
    expect(out.progressMeters).toBeCloseTo(0.7 * track.lengthMeters, -1);
  });
});
