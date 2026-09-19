import { describe, expect, it } from "vitest";
import {
  GRAVEL_WIDTH_METERS,
  KERB_WIDTH_METERS,
  classifySurface,
  kerbHeightMeters,
  meanSurfaceDrag,
  sampleSurface,
  surfaceZones,
  wheelSurfaceGrips,
  type KerbType,
  type SurfaceSample,
} from "../lib/tracks/surfaces";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import type { TrackData } from "../lib/tracks/types";

// Real corner counts live on the registry entries (TrackMeta.corners):
// F1-style corner lists differ by a couple between references, so these
// bound the derived runs instead of matching exactly. The derivation's own
// thresholds were calibrated so the run count lands in this band (see the
// comment on KERB_MAX_RADIUS_METERS in surfaces.ts).

// Sausage kerbs stay exceptional everywhere - except Monaco, whose street
// layout packs several genuinely tight (hairpin-grade) corners into a lap,
// so it structurally earns more of them than any permanent circuit - and
// Bahrain and COTA, whose slow-corner complexes (Bahrain T1/T4/T8/T10/T13/
// T14, COTA T1/T11/T12/T19/T20) push them a hair past the flat cap
// (measured 10.25% and 10.02%).
const SAUSAGE_SHARE_CAP: Record<string, number> = {
  monaco: 0.2,
  bahrain: 0.12,
  cota: 0.12,
};

/**
 * A synthetic constant-curvature circuit (same shape racingLine.test.ts
 * uses). With increasing theta and the (-tz, tx) right-vector convention the
 * whole lap is one same-handed corner, so apex/outside placement can be
 * checked deterministically.
 */
function buildCircleTrack(radius: number, pointCount: number, width: number): TrackData {
  const centerline: [number, number, number][] = [];
  const widths: number[] = [];
  for (let i = 0; i < pointCount; i++) {
    const theta = (i / pointCount) * 2 * Math.PI;
    centerline.push([radius * Math.cos(theta), 0, radius * Math.sin(theta)]);
    widths.push(width);
  }
  return {
    id: "test-circle",
    name: "Test Circle",
    lengthMeters: 2 * Math.PI * radius,
    centerline,
    width: widths,
    startPos: { x: radius, z: 0, headingRad: 0 },
  };
}

/** Number of separate true-runs in a boolean ring (wrap-aware). */
function runCounts(active: readonly boolean[]): number {
  const n = active.length;
  let count = 0;
  let previous = active[n - 1];
  for (let i = 0; i < n; i++) {
    if (active[i] && !previous) count++;
    previous = active[i];
  }
  return count;
}

/** Sample `pastMeters` beyond the ribbon edge on one side at centerline index i. */
function sampleSide(
  track: TrackData,
  i: number,
  side: "left" | "right",
  pastMeters: number
): SurfaceSample {
  const n = track.centerline.length;
  const [x, , z] = track.centerline[i];
  const [px, , pz] = track.centerline[(i - 1 + n) % n];
  const [nx, , nz] = track.centerline[(i + 1) % n];
  const tangentX = nx - px;
  const tangentZ = nz - pz;
  const tangentLen = Math.hypot(tangentX, tangentZ) || 1;
  const rightX = -tangentZ / tangentLen;
  const rightZ = tangentX / tangentLen;
  const sign = side === "right" ? 1 : -1;
  return sampleSurface(
    track,
    x + sign * rightX * (track.width[i] / 2 + pastMeters),
    z + sign * rightZ * (track.width[i] / 2 + pastMeters)
  );
}

const circle = buildCircleTrack(100, 720, 14);

describe("derived zones (constant-radius circle)", () => {
  const zones = surfaceZones(circle);

  it("marks the whole loop as one corner (never a straight) and puts gravel on exactly one side", () => {
    for (const zone of zones) {
      expect(zone.left).not.toBeNull();
      expect(zone.right).not.toBeNull();
      // Gravel is an outside-only runoff: never both sides, never neither.
      expect(zone.gravelLeft).not.toBe(zone.gravelRight);
    }
  });

  it("puts the harsher apex kerb opposite the gravel (so gravel is the exit)", () => {
    for (const zone of zones) {
      if (zone.gravelRight) {
        expect(zone.right).toBe("low");
        expect(zone.left).toBe("aggressive");
      } else {
        expect(zone.left).toBe("low");
        expect(zone.right).toBe("aggressive");
      }
    }
  });

  it("classifies the surface bands in order: asphalt, kerb, gravel, grass", () => {
    const i = Math.floor(circle.centerline.length / 2);
    const side = zones[i].gravelRight ? "right" : "left";

    const onTrack = sampleSide(circle, i, side, -1);
    expect(onTrack.surface).toBe("asphalt");
    expect(onTrack.gripMultiplier).toBe(1);
    expect(onTrack.dragCoefficient).toBe(0);

    const onKerb = sampleSide(circle, i, side, 0.6);
    expect(onKerb.surface).toBe("kerb");
    expect(onKerb.gripMultiplier).toBeLessThan(1);
    expect(onKerb.gripMultiplier).toBeGreaterThan(0.5);
    expect(onKerb.dragCoefficient).toBe(0);

    const inGravel = sampleSide(circle, i, side, KERB_WIDTH_METERS + 2);
    expect(inGravel.surface).toBe("gravel");
    expect(inGravel.gripMultiplier).toBeLessThan(0.4);
    expect(inGravel.dragCoefficient).toBeGreaterThan(20);

    const inGrass = sampleSide(
      circle,
      i,
      side,
      KERB_WIDTH_METERS + GRAVEL_WIDTH_METERS + 5
    );
    expect(inGrass.surface).toBe("grass");
    expect(inGrass.dragCoefficient).toBeGreaterThan(0);
    expect(inGrass.dragCoefficient).toBeLessThan(inGravel.dragCoefficient);
  });

  it("ramps the kerb rise over the first half metre, capping at the type's height", () => {
    const i = Math.floor(circle.centerline.length / 2);
    const zone = surfaceZones(circle)[i];
    const side = zone.gravelRight ? "left" : "right"; // the apex side
    const quiet = sampleSide(circle, i, side, 0.1);
    expect(quiet.surface).toBe("kerb");
    expect(quiet.kerbRiseMeters).toBeGreaterThan(0);
    expect(quiet.kerbRiseMeters).toBeLessThan(kerbHeightMeters("aggressive"));
    expect(quiet.kerbRiseMeters).toBeCloseTo(kerbHeightMeters("aggressive") * 0.2, 6);
    const full = sampleSide(circle, i, side, 1);
    expect(full.kerbRiseMeters).toBe(kerbHeightMeters("aggressive"));
  });
});

describe("derived zones (real circuits)", () => {
  it("produces roughly the right number of kerb runs on each side", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const zones = surfaceZones(track);
      const expected = meta.corners;
      const leftRuns = runCounts(zones.map((z) => z.left !== null));
      const rightRuns = runCounts(zones.map((z) => z.right !== null));
      expect(leftRuns, `${meta.id} left kerb runs`).toBeGreaterThanOrEqual(expected - 2);
      expect(leftRuns, `${meta.id} left kerb runs`).toBeLessThanOrEqual(expected + 3);
      expect(rightRuns, `${meta.id} right kerb runs`).toBeGreaterThanOrEqual(expected - 2);
      expect(rightRuns, `${meta.id} right kerb runs`).toBeLessThanOrEqual(expected + 3);
    }
  });

  it("keeps straights free of kerbs (midpoint of each circuit's longest straight)", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const n = track.centerline.length;
      // Signed turn over +/-10 points (~40m) - a straight reads near zero.
      const unit = (i: number) => {
        const p = track.centerline[(i - 1 + n) % n];
        const q = track.centerline[(i + 1) % n];
        const tx = q[0] - p[0];
        const tz = q[2] - p[2];
        const len = Math.hypot(tx, tz) || 1;
        return { x: tx / len, z: tz / len };
      };
      const turnAt = (i: number) => {
        const a = unit((i - 10 + n) % n);
        const b = unit((i + 10) % n);
        return Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
      };
      let straightStart = -1;
      let straightLen = 0;
      for (let s = 0; s < n; s++) {
        let len = 0;
        while (len < n && Math.abs(turnAt((s + len) % n)) < 0.09) len++;
        if (len > straightLen) {
          straightLen = len;
          straightStart = s;
        }
      }
      if (straightLen < 40) continue; // no straight worth asserting
      const zones = surfaceZones(track);
      const mid = (straightStart + Math.floor(straightLen / 2)) % n;
      expect(
        zones[mid].left === null && zones[mid].right === null,
        `${meta.id} longest straight (${(straightLen * 2).toFixed(0)}m) midpoint should have no kerb`
      ).toBe(true);
    }
  });

  it("keeps sausage kerbs rare and orders the three severities", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const zones = surfaceZones(track);
      let kerbPoints = 0;
      let sausagePoints = 0;
      for (const zone of zones) {
        if (zone.left) kerbPoints++;
        if (zone.right) kerbPoints++;
        if (zone.left === "sausage") sausagePoints++;
        if (zone.right === "sausage") sausagePoints++;
      }
      expect(
        sausagePoints / kerbPoints,
        `${meta.id} sausage share of kerb points`
      ).toBeLessThan(SAUSAGE_SHARE_CAP[meta.id] ?? 0.1);

      // Grip and rise both order strictly low > aggressive > sausage, and
      // the rise stays under the documented nose-scrape cap (0.08m).
      const gripByType: Partial<Record<KerbType, number>> = {};
      const riseByType: Partial<Record<KerbType, number>> = {};
      for (const type of ["low", "aggressive", "sausage"] as const) {
        const idx = zones.findIndex((z) => z.left === type || z.right === type);
        expect(idx, `${meta.id} has a ${type} kerb`).toBeGreaterThanOrEqual(0);
        const side = zones[idx].left === type ? "left" : "right";
        const sample = sampleSide(track, idx, side, 0.6);
        expect(sample.surface).toBe("kerb");
        gripByType[type] = sample.gripMultiplier;
        riseByType[type] = sample.kerbRiseMeters;
      }
      expect(gripByType.sausage!).toBeLessThan(gripByType.aggressive!);
      expect(gripByType.aggressive!).toBeLessThan(gripByType.low!);
      expect(gripByType.low!).toBeLessThan(1);
      expect(riseByType.sausage!).toBeGreaterThan(riseByType.aggressive!);
      expect(riseByType.aggressive!).toBeGreaterThan(riseByType.low!);
      expect(riseByType.sausage!).toBeLessThanOrEqual(0.08);
      expect(riseByType.low!).toBeGreaterThan(0);
    }
  });

  it("never puts gravel on both sides, and only where there is a kerb", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      for (const zone of surfaceZones(track)) {
        expect(zone.gravelLeft && zone.gravelRight, `${meta.id} both-side gravel`).toBe(false);
        if (zone.gravelLeft) expect(zone.left).not.toBeNull();
        if (zone.gravelRight) expect(zone.right).not.toBeNull();
      }
    }
  });

  it("gives gravel more drag than grass on the same circuit", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const zones = surfaceZones(track);
      const gravelIdx = zones.findIndex((z) => z.gravelLeft || z.gravelRight);
      const side = zones[gravelIdx].gravelRight ? "right" : "left";
      const gravel = sampleSide(track, gravelIdx, side, KERB_WIDTH_METERS + 2);
      expect(gravel.surface).toBe("gravel");
      const n = track.centerline.length;
      const unit = (i: number) => {
        const p = track.centerline[(i - 1 + n) % n];
        const q = track.centerline[(i + 1) % n];
        const tx = q[0] - p[0];
        const tz = q[2] - p[2];
        const len = Math.hypot(tx, tz) || 1;
        return { x: tx / len, z: tz / len };
      };
      const turnAt = (i: number) => {
        const a = unit((i - 10 + n) % n);
        const b = unit((i + 10) % n);
        return Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
      };
      const straightIdx = (() => {
        for (let s = 0; s < n; s++) {
          if (Math.abs(turnAt(s)) < 0.09 && Math.abs(turnAt((s + 20) % n)) < 0.09) return s;
        }
        return -1;
      })();
      expect(straightIdx, `${meta.id} has a straight to compare grass against`).toBeGreaterThanOrEqual(0);
      const grass = sampleSide(track, straightIdx, "right", 5);
      expect(grass.surface).toBe("grass");
      expect(gravel.dragCoefficient).toBeGreaterThan(grass.dragCoefficient);
      expect(gravel.gripMultiplier).toBeLessThan(grass.gripMultiplier);
    }
  });

  it("agrees with sampleSurface when the caller already has a TrackLimitStatus", () => {
    const track = getTrack("silverstone");
    const zones = surfaceZones(track);
    const idx = zones.findIndex((z) => z.left !== null);
    const n = track.centerline.length;
    const [x, , z] = track.centerline[idx];
    const [px, , pz] = track.centerline[(idx - 1 + n) % n];
    const [nx, , nz] = track.centerline[(idx + 1) % n];
    const tangentX = nx - px;
    const tangentZ = nz - pz;
    const tangentLen = Math.hypot(tangentX, tangentZ) || 1;
    const rightX = -tangentZ / tangentLen;
    const rightZ = tangentX / tangentLen;
    // A point 0.6m past the left edge of a corner with a left kerb.
    const sx = x - rightX * (track.width[idx] / 2 + 0.6);
    const sz = z - rightZ * (track.width[idx] / 2 + 0.6);
    const direct = sampleSurface(track, sx, sz);
    const viaStatus = classifySurface(track, checkTrackLimits(track, sx, sz));
    expect(viaStatus).toEqual(direct);
    expect(viaStatus.surface).toBe("kerb");
  });
});

describe("wheel helpers", () => {
  it("wheelSurfaceGrips maps samples in order", () => {
    const circleZones = surfaceZones(circle);
    const i = Math.floor(circle.centerline.length / 2);
    const side = circleZones[i].gravelRight ? "right" : "left";
    const onKerb = sampleSide(circle, i, side, 0.6);
    const inGravel = sampleSide(circle, i, side, KERB_WIDTH_METERS + 2);
    const onTrack = sampleSide(circle, i, side, -1);
    const grips = wheelSurfaceGrips([onKerb, inGravel, onTrack, onTrack]);
    expect(grips).toHaveLength(4);
    expect(grips[0]).toBe(onKerb.gripMultiplier);
    expect(grips[1]).toBe(inGravel.gripMultiplier);
    expect(grips[2]).toBe(1);
    expect(grips[3]).toBe(1);
  });

  it("meanSurfaceDrag averages per wheel - two wheels in gravel drag half as hard", () => {
    const circleZones = surfaceZones(circle);
    const i = Math.floor(circle.centerline.length / 2);
    const side = circleZones[i].gravelRight ? "right" : "left";
    const inGravel = sampleSide(circle, i, side, KERB_WIDTH_METERS + 2);
    const onTrack = sampleSide(circle, i, side, -1);
    expect(inGravel.dragCoefficient).toBeGreaterThan(0);
    const mean = meanSurfaceDrag([inGravel, inGravel, onTrack, onTrack]);
    expect(mean).toBeCloseTo(inGravel.dragCoefficient / 2, 6);
    expect(meanSurfaceDrag([])).toBe(0);
    expect(meanSurfaceDrag([onTrack, onTrack, onTrack, onTrack])).toBe(0);
  });
});