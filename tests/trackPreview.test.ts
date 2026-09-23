import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import {
  MAP_MAX_ZOOM_W,
  MAP_MIN_ZOOM_W,
  WORLD_MAP_H,
  WORLD_MAP_W,
  formatLapLength,
  fullWorldView,
  getLandPolygons,
  getOutline,
  landPath,
  mapViewBox,
  outlinePath,
  panMapView,
  previewStats,
  projectPin,
  zoomMapView,
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

describe("world map view", () => {
  it("ships real coastline geometry, not an empty panel", () => {
    const polys = getLandPolygons();
    expect(polys.length).toBeGreaterThan(50);
    const d = landPath(polys);
    expect(d.startsWith("M")).toBe(true);
    expect(d.endsWith("Z")).toBe(true);
    // All pins sit on land's own coordinate frame (degrees).
    for (const meta of TRACKS) {
      expect(meta.lon).toBeGreaterThanOrEqual(-180);
      expect(meta.lon).toBeLessThanOrEqual(180);
    }
  });

  it("zooms about the anchor and clamps to the zoom range", () => {
    const full = fullWorldView();
    expect(full).toEqual({ x: 0, y: 0, w: WORLD_MAP_W });
    const zoomed = zoomMapView(full, 320, 160, 2);
    expect(zoomed.w).toBeCloseTo(WORLD_MAP_W / 2);
    // The anchor stays put.
    expect(zoomed.x + zoomed.w / 2).toBeCloseTo(320);
    // Factor 1000 bottoms out at the closest zoom, not zero/negative.
    expect(zoomMapView(full, 0, 0, 1000).w).toBe(MAP_MIN_ZOOM_W);
    expect(zoomMapView(full, 0, 0, 0.001).w).toBe(MAP_MAX_ZOOM_W);
  });

  it("pans within an overscroll-clamped world", () => {
    const full = fullWorldView();
    expect(panMapView(full, 10, 5)).toEqual({ x: 10, y: 5, w: WORLD_MAP_W });
    // Far past the edge clamps instead of losing the planet.
    const clamped = panMapView(full, -10000, 10000);
    expect(clamped.x).toBeGreaterThanOrEqual(-clamped.w * 0.5);
    expect(clamped.y).toBeLessThanOrEqual(WORLD_MAP_H - (clamped.w / WORLD_MAP_W) * WORLD_MAP_H * 0.5);
  });

  it("serializes to a well-formed viewBox", () => {
    expect(mapViewBox(fullWorldView())).toBe(`0 0 ${WORLD_MAP_W} ${WORLD_MAP_H}`);
  });
});

describe("circuit browser regions and labels", () => {
  it("puts every circuit in exactly one region, and frames each region's pins", async () => {
    const { TRACKS } = await import("../lib/tracks/registry");
    const { MAP_REGIONS, regionOf, regionView, projectPin, WORLD_MAP_W, WORLD_MAP_H } = await import("../lib/tracks/preview");
    expect(regionOf({ lat: 52.07, lon: -1.02 })).toBe("europe");
    expect(regionOf({ lat: 30.13, lon: -97.63 })).toBe("americas");
    expect(regionOf({ lat: 26.03, lon: 50.51 })).toBe("middle-east");
    expect(regionOf({ lat: -37.85, lon: 144.97 })).toBe("asia-pacific");
    let total = 0;
    for (const { id } of MAP_REGIONS.filter((r) => r.id !== "world")) {
      const members = TRACKS.filter((t) => regionOf(t) === id);
      expect(members.length).toBeGreaterThan(0);
      total += members.length;
      const view = regionView(TRACKS, id);
      const h = (view.w / WORLD_MAP_W) * WORLD_MAP_H;
      for (const t of members) {
        const p = projectPin(t.lat, t.lon, WORLD_MAP_W, WORLD_MAP_H);
        expect(p.x).toBeGreaterThan(view.x);
        expect(p.x).toBeLessThan(view.x + view.w);
        expect(p.y).toBeGreaterThan(view.y);
        expect(p.y).toBeLessThan(view.y + h);
      }
    }
    expect(total).toBe(TRACKS.length);
  });

  it("places labels without overlaps, and always places the priority pin", async () => {
    const { placeLabels } = await import("../lib/tracks/preview");
    const pins = [
      { id: "a", x: 0, y: 0, text: "Alpha" },
      { id: "b", x: 20, y: 0, text: "Bravo" },
      { id: "c", x: 10, y: 3, text: "Charlie" },
    ];
    const placed = placeLabels(pins, ["c"], 7, 13, 9);
    expect(placed.has("c")).toBe(true);
    const rect = (p: (typeof pins)[number], side: string) => {
      const w = p.text.length * 7;
      if (side === "right") return [p.x + 9, p.y - 6.5, p.x + 9 + w, p.y + 6.5];
      if (side === "left") return [p.x - 9 - w, p.y - 6.5, p.x - 9, p.y + 6.5];
      if (side === "above") return [p.x - w / 2, p.y - 22, p.x + w / 2, p.y - 9];
      return [p.x - w / 2, p.y + 9, p.x + w / 2, p.y + 22];
    };
    const boxes = pins.filter((p) => placed.has(p.id)).map((p) => rect(p, placed.get(p.id)!));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]];
        expect(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]).toBe(false);
      }
    }
    // Far-apart pins all get their preferred right-hand spot.
    const spread = placeLabels(
      pins.map((p, i) => ({ ...p, y: i * 100 })),
      [],
      7,
      13,
      9
    );
    expect([...spread.values()]).toEqual(["right", "right", "right"]);
  });
});
