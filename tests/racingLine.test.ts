import { describe, expect, it } from "vitest";
import { computeRacingLine } from "../lib/tracks/racingLine";
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

describe("computeRacingLine", () => {
  it("hugs the inside of a constant-curvature turn (closer to the circle's own center than the centerline)", () => {
    const circle = buildCircleTrack(100, 720, 14);
    const line = computeRacingLine(circle);
    for (let i = 0; i < circle.centerline.length; i++) {
      const [cx, , cz] = circle.centerline[i];
      const [lx, , lz] = line[i];
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
      const [lx, , lz] = line[i];
      const lateralOffset = Math.hypot(lx - cx, lz - cz);
      expect(lateralOffset).toBeLessThanOrEqual(circle.width[i] / 2 + 1e-6);
    }
  });

  it("stays on the centerline for a perfectly straight track", () => {
    const centerline: [number, number, number][] = [];
    const widths: number[] = [];
    for (let i = 0; i < 200; i++) {
      centerline.push([0, 0, i]);
      widths.push(14);
    }
    const straight: TrackData = {
      id: "test-straight",
      name: "Test Straight",
      lengthMeters: 200,
      centerline,
      width: widths,
      startPos: { x: 0, z: 0, headingRad: 0 },
    };
    const line = computeRacingLine(straight);
    for (let i = 30; i < 170; i++) {
      const [lx, , lz] = line[i];
      expect(lx).toBeCloseTo(0, 5);
      expect(lz).toBeCloseTo(i, 5);
    }
  });

  it("produces one point per centerline point on the real track, with no NaNs", () => {
    const line = computeRacingLine(track);
    expect(line.length).toBe(track.centerline.length);
    for (const [x, y, z] of line) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
    }
  });
});
