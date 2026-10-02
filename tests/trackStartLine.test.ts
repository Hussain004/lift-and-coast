import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { GRID_BEHIND_METERS } from "../lib/race/grid";

/**
 * Regression: every circuit's start/finish line must be on a straight.
 *
 * This is not cosmetic. The grid is placed BACKWARD from the start line along
 * the centerline (lib/race/grid.ts), so a start line in a corner strings the
 * back of the field out through the corner ahead of it - which is what the
 * original report was seeing at Sepang. The pit lane is anchored relative to
 * the same line, so it inherits the same fault.
 *
 * Measured before the fix, as heading change over a 50m window centred on the
 * start point:
 *
 *   sochi       91.1 deg      budapest    52.1 deg
 *   sepang      90.5 deg      yasmarina   32.1 deg
 *   (every other circuit: under 3 deg)
 *
 * Those four came from the build pipeline's TUMFTM s=0 locator, whose s=0 did
 * not land on the start straight for them. See locateStraightestStart in
 * scripts/build-track.mts for the structural fix; this test is the guard that
 * catches a future rebuild reintroducing it.
 */

/** A start line tighter than this over 50m is a straight. Real circuits
 *  measure 0.0-2.8 deg; the worst fault measured 32 deg, so the threshold has
 *  an order of magnitude of headroom on both sides. */
const MAX_DEG_PER_50M = 8;

interface Measurement {
  id: string;
  deg: number;
}

/** Heading change over a 50m window centred on the start position. */
function startLineCurvature(trackId: string): number {
  const track = getTrack(trackId);
  const cl = track.centerline;
  const n = cl.length;
  const cumulative: number[] = new Array(n + 1);
  cumulative[0] = 0;
  for (let i = 0; i < n; i += 1) {
    const a = cl[i];
    const b = cl[(i + 1) % n];
    cumulative[i + 1] = cumulative[i] + Math.hypot(b[0] - a[0], b[2] - a[2]);
  }
  const total = cumulative[n];

  const headingAt = (distance: number): number => {
    const wrapped = ((distance % total) + total) % total;
    let low = 0;
    let high = n - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (cumulative[mid] <= wrapped) low = mid;
      else high = mid - 1;
    }
    const a = cl[low];
    const b = cl[(low + 1) % n];
    return Math.atan2(b[0] - a[0], b[2] - a[2]);
  };

  // The start point's own arc station, found the same way the runtime does
  // (nearest centerline point).
  let nearest = 0;
  let bestSq = Infinity;
  for (let i = 0; i < n; i += 1) {
    const dx = cl[i][0] - track.startPos.x;
    const dz = cl[i][2] - track.startPos.z;
    const d = dx * dx + dz * dz;
    if (d < bestSq) {
      bestSq = d;
      nearest = i;
    }
  }
  const station = cumulative[nearest];

  let d = headingAt(station + 25) - headingAt(station - 25);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return (Math.abs(d) * 180) / Math.PI;
}

describe("start lines sit on a straight", () => {
  const all: Measurement[] = TRACKS.map((t) => ({ id: t.id, deg: startLineCurvature(t.id) }));

  it("covers every shipped circuit", () => {
    expect(all.length).toBeGreaterThanOrEqual(30);
  });

  it("puts no circuit's start line on a corner", () => {
    // One assertion over the whole set, so the failure names the circuit rather
    // than producing thirty near-identical test names.
    const offenders = all.filter((m) => m.deg > MAX_DEG_PER_50M);
    expect(
      offenders.map((o) => `${o.id} ${o.deg.toFixed(1)}deg`)
    ).toEqual([]);
  });

  it("keeps the start point on the racing surface", () => {
    // A start line drifting off the ribbon would put pole in the grass, which
    // is the same class of fault seen from a different angle.
    for (const t of TRACKS) {
      const track = getTrack(t.id);
      const n = track.centerline.length;
      let nearest = 0;
      let best = Infinity;
      for (let i = 0; i < n; i += 1) {
        const d = (track.centerline[i][0] - track.startPos.x) ** 2 + (track.centerline[i][2] - track.startPos.z) ** 2;
        if (d < best) {
          best = d;
          nearest = i;
        }
      }
      // Within the paved width, with a metre of slack for the authored point.
      expect(Math.sqrt(best), `${t.id} start point off the ribbon`).toBeLessThan(track.width[nearest] / 2 + 1);
    }
  });

  it("leaves room behind the line for a full grid", () => {
    // The grid walks backward from the line, so a start line at the very end of
    // its straight would still put P20 in the scenery. 20 cars is 10 rows.
    const gridReach = Math.ceil(19 / 2) * GRID_BEHIND_METERS;
    expect(gridReach).toBe(80);
    for (const t of TRACKS) {
      const deg = startLineCurvature(t.id);
      // Empirically every circuit is under 3 deg, which is a straight for 80m.
      expect(deg, `${t.id} has only ${deg.toFixed(1)}deg over 50m behind the line`).toBeLessThan(MAX_DEG_PER_50M);
    }
  });

  it("reports the four repaired circuits as straight", () => {
    // Named explicitly so a regression points at the fix rather than at an
    // anonymous threshold.
    for (const id of ["sepang", "sochi", "budapest", "yasmarina"]) {
      const m = all.find((x) => x.id === id);
      expect(m, id).toBeDefined();
      expect(m!.deg, `${id} start line is ${m!.deg.toFixed(1)}deg/50m`).toBeLessThan(MAX_DEG_PER_50M);
    }
  });
});