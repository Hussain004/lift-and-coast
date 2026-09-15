import { describe, expect, it } from "vitest";
import {
  MAX_ACCEL_MS2,
  MAX_DECEL_MS2,
  buildRacingLineRibbon,
  computeRacingLine,
  type ThrottleZone,
} from "../lib/tracks/racingLine";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

// A synthetic circular track (constant curvature), traversed with
// increasing theta - lets the "hugs the inside of the turn" property be
// checked directly (distance to the circle's own center), independent of
// any particular track's real corner shapes.
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

describe("computeRacingLine geometry", () => {
  it("hugs the inside of a constant-curvature turn (closer to the circle's own center than the centerline)", () => {
    const circle = buildCircleTrack(100, 720, 14);
    const line = computeRacingLine(circle);
    for (let i = 0; i < circle.centerline.length; i++) {
      const [cx, , cz] = circle.centerline[i];
      const [lx, , lz] = line[i].position;
      const centerDist = Math.hypot(cx, cz);
      const lineDist = Math.hypot(lx, lz);
      expect(lineDist).toBeLessThan(centerDist);
    }
  });

  it("stays within the track's own half-width everywhere", () => {
    const circle = buildCircleTrack(100, 720, 14);
    const line = computeRacingLine(circle);
    for (let i = 0; i < circle.centerline.length; i++) {
      const [cx, , cz] = circle.centerline[i];
      const [lx, , lz] = line[i].position;
      const lateralOffset = Math.hypot(lx - cx, lz - cz);
      expect(lateralOffset).toBeLessThanOrEqual(circle.width[i] / 2 + 1e-6);
    }
  });

  it("stays on the centerline for a perfectly straight track", () => {
    const centerline: [number, number, number][] = [];
    const widths: number[] = [];
    for (let i = 0; i < 300; i++) {
      centerline.push([0, 0, i]);
      widths.push(14);
    }
    const straight: TrackData = {
      id: "test-straight",
      name: "Test Straight",
      lengthMeters: 300,
      centerline,
      width: widths,
      startPos: { x: 0, z: 0, headingRad: 0 },
    };
    const line = computeRacingLine(straight);
    // Avoid both ends of the array: this is a closed loop internally, so
    // indices near the seam (where index 299 wraps to 0) see a fake sharp
    // "corner" from the discontinuity - real closed tracks don't have this
    // artifact, only this synthetic non-closed test track does.
    for (let i = 80; i < 220; i++) {
      const [lx, , lz] = line[i].position;
      expect(lx).toBeCloseTo(0, 5);
      expect(lz).toBeCloseTo(i, 5);
    }
  });

  it("produces one point per centerline point on the real track, with no NaNs", () => {
    const line = computeRacingLine(track);
    expect(line.length).toBe(track.centerline.length);
    for (const p of line) {
      expect(Number.isFinite(p.position[0])).toBe(true);
      expect(Number.isFinite(p.position[1])).toBe(true);
      expect(Number.isFinite(p.position[2])).toBe(true);
      expect(Number.isFinite(p.targetSpeedMs)).toBe(true);
    }
  });

  it("does not zigzag on the real track (offset direction reverses far less often than raw per-point curvature would)", () => {
    // A direct measure of "sudden turns a car can't follow": count how
    // often the line's signed lateral offset from the centerline reverses
    // direction. An earlier, unsmoothed version of this line reversed
    // direction 342 times over this same track (checked numerically before
    // adding the smoothing pass) - a real racing line should reverse
    // roughly once or twice per real corner, not once every few points.
    const line = computeRacingLine(track);
    const n = line.length;

    // Signed lateral offset via projection onto the track's own local
    // perpendicular ("right") direction - not just the raw X difference,
    // which isn't aligned with the track's direction of travel in general
    // and would misclassify plenty of genuine non-reversals as reversals.
    function rightVectorAt(i: number) {
      const p = track.centerline[(i - 1 + n) % n];
      const q = track.centerline[(i + 1) % n];
      const tx = q[0] - p[0];
      const tz = q[2] - p[2];
      const len = Math.hypot(tx, tz) || 1;
      return { x: -tz / len, z: tx / len };
    }

    const lateralOffsets = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const [cx, , cz] = track.centerline[i];
      const [px, , pz] = line[i].position;
      const right = rightVectorAt(i);
      lateralOffsets[i] = (px - cx) * right.x + (pz - cz) * right.z;
    }

    // A deadband on the delta is essential here, not optional: on a long
    // flat/near-zero-offset stretch (e.g. a straight), the true derivative
    // hovers so close to zero that plain floating-point noise from the
    // position round-trip flips Math.sign() dozens of times with no real
    // direction change behind it (found by comparing this reconstruction
    // against an independently-computed offset array that agreed to
    // within 1e-13 in VALUE but gave a wildly different reversal count
    // with no deadband - 224 vs. 28 - purely from noise-level sign flips
    // in those near-zero regions).
    const DEADBAND_METERS = 0.05;
    let reversals = 0;
    let prevSign = 0;
    for (let i = 0; i < n; i++) {
      const delta = lateralOffsets[(i + 1) % n] - lateralOffsets[i];
      if (Math.abs(delta) < DEADBAND_METERS) continue;
      const sign = Math.sign(delta);
      if (prevSign !== 0 && sign !== prevSign) reversals++;
      prevSign = sign;
    }
    expect(reversals).toBeLessThan(60);
  });
});

describe("computeRacingLine speed profile", () => {
  it("never demands more accel/decel between consecutive points than the physically-plausible caps", () => {
    const line = computeRacingLine(track);
    const n = line.length;
    const epsilon = 0.05; // floating-point slack
    for (let i = 0; i < n; i++) {
      const a = line[i];
      const b = line[(i + 1) % n];
      const dist = Math.hypot(b.position[0] - a.position[0], b.position[2] - a.position[2]);
      if (dist < 1e-6) continue;
      const signedAccel = (b.targetSpeedMs ** 2 - a.targetSpeedMs ** 2) / (2 * dist);
      expect(signedAccel).toBeLessThanOrEqual(MAX_ACCEL_MS2 + epsilon);
      expect(signedAccel).toBeGreaterThanOrEqual(-MAX_DECEL_MS2 - epsilon);
    }
  });

  it("produces every throttle zone across a real lap, not just one color", () => {
    const line = computeRacingLine(track);
    const zonesSeen = new Set<ThrottleZone>(line.map((p) => p.zone));
    expect(zonesSeen.has("throttle")).toBe(true);
    expect(zonesSeen.has("brake-hard")).toBe(true);
  });

  it("is mostly throttle on a fast, flowing track like Silverstone (not mostly braking)", () => {
    const line = computeRacingLine(track);
    const throttleFraction = line.filter((p) => p.zone === "throttle").length / line.length;
    expect(throttleFraction).toBeGreaterThan(0.4);
  });

  it("does not flicker between zones (a driver needs a readable color band, not noise)", () => {
    // The per-point deceleration used to classify each point's zone
    // inherits the same small-scale centerline noise the offset signal has
    // (see the module comment) - unsmoothed, 83 of 145 zone "runs" on the
    // real track were 3 points (~6m) or shorter, mostly rapid brake-hard/
    // brake-medium alternation rather than a single growing-more-urgent
    // band before a corner. Fixed by smoothing a DISPLAY-ONLY copy of the
    // final speed profile for classification (see displaySpeedMs in
    // racingLine.ts) - never the AI-facing targetSpeedMs itself, since an
    // earlier attempt that smoothed the AI-facing signal directly caused a
    // real flip at a full lap-plus (see aiOpponent.test.ts's own history).
    // This gives 0 short runs on the real track; the threshold below still
    // has real margin above that; not a tight fit.
    const line = computeRacingLine(track);
    const n = line.length;
    let shortRuns = 0;
    let cur = line[0].zone;
    let runLength = 1;
    for (let i = 1; i <= n; i++) {
      const zone = line[i % n].zone;
      if (zone === cur) {
        runLength++;
      } else {
        if (runLength <= 3) shortRuns++;
        cur = zone;
        runLength = 1;
      }
    }
    expect(shortRuns).toBeLessThan(10);
  });
});

describe("buildRacingLineRibbon", () => {
  const ZONE_COLOR: Record<ThrottleZone, [number, number, number]> = {
    throttle: [0, 1, 0],
    lift: [1, 1, 0],
    "brake-medium": [1, 0.5, 0],
    "brake-hard": [1, 0, 0],
  };

  it("produces two vertices per line point, each colored by that point's zone", () => {
    const line = computeRacingLine(track);
    const ribbon = buildRacingLineRibbon(line, 1.2, ZONE_COLOR);
    expect(ribbon.positions.length).toBe(line.length * 2 * 3);
    expect(ribbon.colors.length).toBe(line.length * 2 * 3);
    for (let i = 0; i < line.length; i++) {
      const expected = ZONE_COLOR[line[i].zone];
      const leftIdx = i * 2 * 3;
      const rightIdx = leftIdx + 3;
      expect([ribbon.colors[leftIdx], ribbon.colors[leftIdx + 1], ribbon.colors[leftIdx + 2]]).toEqual(expected);
      expect([ribbon.colors[rightIdx], ribbon.colors[rightIdx + 1], ribbon.colors[rightIdx + 2]]).toEqual(expected);
    }
  });

  it("offsets left/right vertices from the centerline point by the given half-width", () => {
    const line = computeRacingLine(track);
    const ribbon = buildRacingLineRibbon(line, 1.2, ZONE_COLOR);
    for (let i = 0; i < line.length; i++) {
      const [px, , pz] = line[i].position;
      const leftIdx = i * 2 * 3;
      const rightIdx = leftIdx + 3;
      const leftDist = Math.hypot(ribbon.positions[leftIdx] - px, ribbon.positions[leftIdx + 2] - pz);
      const rightDist = Math.hypot(ribbon.positions[rightIdx] - px, ribbon.positions[rightIdx + 2] - pz);
      // 3 decimal places, not 5 - positions are stored in a Float32Array,
      // whose ~7-significant-figure precision doesn't reliably hold to 5
      // decimal places once combined with Math.hypot's own rounding.
      expect(leftDist).toBeCloseTo(1.2, 3);
      expect(rightDist).toBeCloseTo(1.2, 3);
    }
  });

  it("produces valid triangle indices (all within the vertex count)", () => {
    const line = computeRacingLine(track);
    const ribbon = buildRacingLineRibbon(line, 1.2, ZONE_COLOR);
    const vertexCount = line.length * 2;
    expect(ribbon.indices.length).toBe(line.length * 6);
    for (const idx of ribbon.indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
  });
});
