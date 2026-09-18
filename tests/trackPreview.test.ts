import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import {
  formatLapLength,
  getOutline,
  outlinePath,
  previewStats,
  projectPin,
} from "../lib/tracks/preview";
import outlinesData from "../data/tracks/outlines.json";

describe("track outline sidecar (data/tracks/outlines.json)", () => {
  it("covers exactly the registered circuits", () => {
    // Order follows the build script's own list, so compare as sets.
    expect(outlinesData.map((o) => o.id).sort()).toEqual(TRACKS.map((t) => t.id).sort());
  });

  it("stays a menu-safe sketch, not a second copy of the geometry", () => {
    for (const outline of outlinesData) {
      // Stride-sampled to ~120 points: two orders of magnitude below the
      // ~3000-point built centerline the menu bundle must never import.
      expect(outline.points.length).toBeGreaterThan(90);
      expect(outline.points.length).toBeLessThan(140);
      expect(outline.lengthMeters).toBe(getTrack(outline.id).lengthMeters);
      expect(["clockwise", "counterclockwise"]).toContain(outline.direction);
    }
  });

  it("locks the north-up clockwise convention on a known circuit", () => {
    // Silverstone genuinely runs clockwise, so this pins the build script's
    // signed-area sign to reality rather than to itself.
    expect(getOutline("silverstone").direction).toBe("clockwise");
  });

  it("spans the built centerline's own bounding box", () => {
    for (const outline of outlinesData) {
      const line = getTrack(outline.id).centerline;
      const xs = line.map(([x]) => x);
      const zs = line.map(([, , z]) => z);
      const ox = outline.points.map(([x]) => x);
      const oz = outline.points.map(([, z]) => z);
      // Stride sampling can only shave a sub-segment off each extreme.
      expect(Math.min(...ox)).toBeGreaterThan(Math.min(...xs) - 3);
      expect(Math.max(...ox)).toBeLessThan(Math.max(...xs) + 3);
      expect(Math.min(...oz)).toBeGreaterThan(Math.min(...zs) - 3);
      expect(Math.max(...oz)).toBeLessThan(Math.max(...zs) + 3);
    }
  });
});

describe("registry pin metadata", () => {
  it("carries a finite on-earth pin and a positive corner count per circuit", () => {
    for (const meta of TRACKS) {
      expect(Number.isFinite(meta.lat)).toBe(true);
      expect(Number.isFinite(meta.lon)).toBe(true);
      expect(meta.lat).toBeGreaterThan(-90);
      expect(meta.lat).toBeLessThan(90);
      expect(meta.lon).toBeGreaterThanOrEqual(-180);
      expect(meta.lon).toBeLessThanOrEqual(180);
      expect(Number.isInteger(meta.corners)).toBe(true);
      expect(meta.corners).toBeGreaterThan(0);
    }
  });
});

describe("preview helpers", () => {
  it("projects lon/lat equirectangularly across the strip", () => {
    expect(projectPin(90, -180, 520, 170)).toEqual({ x: 0, y: 0 });
    expect(projectPin(-90, 180, 520, 170)).toEqual({ x: 520, y: 170 });
    const suzuka = TRACKS.find((t) => t.id === "suzuka")!;
    const pin = projectPin(suzuka.lat, suzuka.lon, 520, 170);
    // Japan sits far east of the European cluster.
    expect(pin.x).toBeGreaterThan(400);
    for (const meta of TRACKS) {
      const p = projectPin(meta.lat, meta.lon, 520, 170);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(520);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(170);
    }
  });

  it("fits an outline path inside its box with the lap line marked", () => {
    const outline = getOutline("spa");
    const fitted = outlinePath(outline.points, 190, 14);
    expect(fitted.d.startsWith("M")).toBe(true);
    expect(fitted.d.endsWith("Z")).toBe(true);
    expect(fitted.scale).toBeGreaterThan(0);
    // Every projected point lands inside the padded box.
    const coords = fitted.d
      .slice(0, -2)
      .split(" ")
      .map((seg) => seg.slice(1).split(",").map(Number));
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(14 - 1e-6);
      expect(x).toBeLessThanOrEqual(190 - 14 + 1e-6);
      expect(y).toBeGreaterThanOrEqual(14 - 1e-6);
      expect(y).toBeLessThanOrEqual(190 - 14 + 1e-6);
    }
    // The start marker is the projection of the first outline point (the
    // path itself rounds to 0.1, so compare loosely).
    const dStart = coords[0];
    expect(fitted.start.x).toBeCloseTo(dStart[0], 0);
    expect(fitted.start.y).toBeCloseTo(dStart[1], 0);
  });

  it("prints preview stats from registry and outline facts", () => {
    expect(formatLapLength(5891)).toBe("5,891 m");
    const monza = TRACKS.find((t) => t.id === "monza")!;
    expect(previewStats(monza)).toEqual({
      length: "5,795 m",
      corners: "11",
      direction: "Clockwise",
    });
  });
});
