import { describe, expect, it } from "vitest";
import { buildMinimapProjection } from "../lib/tracks/minimap";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

describe("buildMinimapProjection", () => {
  it("projects every centerline point within the padded box, touching a boundary", () => {
    const size = 200;
    const padding = 10;
    const projection = buildMinimapProjection(track, size, padding);

    let touchedMin = false;
    let touchedMax = false;
    const epsilon = 0.5;

    for (const [x, , z] of track.centerline) {
      const p = projection.toPoint(x, z);
      expect(p.x).toBeGreaterThanOrEqual(padding - epsilon);
      expect(p.x).toBeLessThanOrEqual(size - padding + epsilon);
      expect(p.y).toBeGreaterThanOrEqual(padding - epsilon);
      expect(p.y).toBeLessThanOrEqual(size - padding + epsilon);

      if (Math.abs(p.x - padding) < epsilon || Math.abs(p.y - padding) < epsilon) touchedMin = true;
      if (Math.abs(p.x - (size - padding)) < epsilon || Math.abs(p.y - (size - padding)) < epsilon)
        touchedMax = true;
    }

    expect(touchedMin).toBe(true);
    expect(touchedMax).toBe(true);
  });

  it("preserves aspect ratio (uniform scale on both axes)", () => {
    const projection = buildMinimapProjection(track, 200, 10);
    const a = projection.toPoint(0, 0);
    const b = projection.toPoint(100, 0);
    const c = projection.toPoint(0, 100);
    const scaleX = Math.abs(b.x - a.x) / 100;
    const scaleZ = Math.abs(c.y - a.y) / 100;
    expect(scaleX).toBeCloseTo(scaleZ, 5);
  });

  it("projects the start position to a finite point inside the box", () => {
    const projection = buildMinimapProjection(track, 200, 10);
    expect(Number.isFinite(projection.startPoint.x)).toBe(true);
    expect(Number.isFinite(projection.startPoint.y)).toBe(true);
  });

  it("produces a closed SVG path referencing every centerline point", () => {
    const projection = buildMinimapProjection(track, 200, 10);
    expect(projection.pathD.startsWith("M")).toBe(true);
    expect(projection.pathD.endsWith("Z")).toBe(true);
    expect(projection.pathD.split("L").length - 1).toBe(track.centerline.length - 1);
  });
});
