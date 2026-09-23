// Plan section 8 (Track Preview): menu-safe circuit outlines and the pure
// math that draws them. The race route's per-track JSON is ~550KB of
// centerline the menu bundle must never import (see lib/tracks/registry.ts),
// so scripts/build-track.mts emits the tiny data/tracks/outlines.json
// sidecar instead - a stride-sampled top-down outline plus the facts the
// preview prints - and everything here works from that plus the registry.
import outlinesData from "../../data/tracks/outlines.json";
import worldData from "../../data/world.json";
import { TRACKS, type TrackMeta } from "./registry";

export interface TrackOutline {
  id: string;
  lengthMeters: number;
  direction: "clockwise" | "counterclockwise";
  /** Stride-sampled [x, z] projected meters, loop order, index 0 at the lap line. */
  points: [number, number][];
}

const OUTLINES: TrackOutline[] = (outlinesData as TrackOutline[]).filter((o) =>
  TRACKS.some((t) => t.id === o.id)
);

export function getOutline(id: string): TrackOutline {
  return OUTLINES.find((o) => o.id === id) ?? OUTLINES[0];
}

/** Equirectangular pin position on a width x height world strip. */
export function projectPin(lat: number, lon: number, width: number, height: number): {
  x: number;
  y: number;
} {
  return {
    x: ((lon + 180) / 360) * width,
    y: ((90 - lat) / 180) * height,
  };
}

// Real coastline geometry for the menu world map: Natural Earth 110m land
// (public domain), exterior rings only, Douglas-Peucker simplified and
// rounded at vendor time (see data/world.json) - ~40KB for the whole
// planet, a fraction of one track's built JSON.
export const WORLD_MAP_W = 640;
export const WORLD_MAP_H = 320;

/** [lon, lat] rings in degrees. */
export function getLandPolygons(): [number, number][][] {
  return (worldData as { polygons: [number, number][][] }).polygons;
}

/** One SVG path for all land, in WORLD_MAP_W x WORLD_MAP_H units. */
export function landPath(polygons: [number, number][][]): string {
  return polygons
    .map((ring) => {
      const pts = ring.map(([lon, lat]) => {
        const p = projectPin(lat, lon, WORLD_MAP_W, WORLD_MAP_H);
        return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
      });
      return "M" + pts.join("L") + "Z";
    })
    .join("");
}

/**
 * Zoom/pan viewBox state, in WORLD_MAP_* units with the map's 2:1 aspect
 * locked (h always follows w) so geography never stretches. Pure functions
 * so the clamping is unit-testable without a DOM.
 */
export interface MapView {
  x: number;
  y: number;
  w: number;
}

export const MAP_MIN_ZOOM_W = WORLD_MAP_W / 12;
export const MAP_MAX_ZOOM_W = WORLD_MAP_W;

export function fullWorldView(): MapView {
  return { x: 0, y: 0, w: WORLD_MAP_W };
}

function viewH(w: number): number {
  return (w / WORLD_MAP_W) * WORLD_MAP_H;
}

/** Keeps up to half a viewport of overscroll past each edge. */
export function clampMapView(view: MapView): MapView {
  const w = Math.min(MAP_MAX_ZOOM_W, Math.max(MAP_MIN_ZOOM_W, view.w));
  const h = viewH(w);
  return {
    w,
    x: Math.min(WORLD_MAP_W - w * 0.5, Math.max(-w * 0.5, view.x)),
    y: Math.min(WORLD_MAP_H - h * 0.5, Math.max(-h * 0.5, view.y)),
  };
}

/** Zooms by factor about the anchor point (SVG units), preserving it. */
export function zoomMapView(view: MapView, anchorX: number, anchorY: number, factor: number): MapView {
  const w = Math.min(MAP_MAX_ZOOM_W, Math.max(MAP_MIN_ZOOM_W, view.w / factor));
  const ratio = w / view.w;
  return clampMapView({
    w,
    x: anchorX - (anchorX - view.x) * ratio,
    y: anchorY - (anchorY - view.y) * ratio,
  });
}

/** Pans by an SVG-units delta. */
export function panMapView(view: MapView, dx: number, dy: number): MapView {
  return clampMapView({ ...view, x: view.x + dx, y: view.y + dy });
}

/** viewBox attribute value for a view. */
export function mapViewBox(view: MapView): string {
  return `${view.x} ${view.y} ${view.w} ${viewH(view.w)}`;
}

/**
 * Fits an outline's bounding box into a sizePx square with padPx of margin
 * and returns the SVG path `d` plus the scale, so tests can assert the fit
 * without an SVG parser. Same convention as the in-race minimap (X -> path
 * X, Z -> path Y, no flip), which is north-up because the projection is
 * z-south-positive (see scripts/build-track.mts).
 */
export function outlinePath(
  points: [number, number][],
  sizePx: number,
  padPx: number
): { d: string; scale: number; start: { x: number; y: number } } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const scale = Math.min(
    (sizePx - padPx * 2) / Math.max(1e-9, maxX - minX),
    (sizePx - padPx * 2) / Math.max(1e-9, maxZ - minZ)
  );
  const px = (x: number) => padPx + (x - minX) * scale;
  const py = (z: number) => padPx + (z - minZ) * scale;
  const d =
    points
      .map(([x, z], i) => `${i === 0 ? "M" : "L"}${px(x).toFixed(1)},${py(z).toFixed(1)}`)
      .join(" ") + " Z";
  return { d, scale, start: { x: px(points[0][0]), y: py(points[0][1]) } };
}

/** "5891 m" style lap length for the preview stats. */
export function formatLapLength(lengthMeters: number): string {
  return `${lengthMeters.toLocaleString("en-US")} m`;
}

/** The preview's stat line for one registry entry. */
export function previewStats(meta: TrackMeta): { length: string; corners: string; direction: string } {
  const outline = getOutline(meta.id);
  return {
    length: formatLapLength(outline.lengthMeters),
    corners: String(meta.corners),
    direction: outline.direction === "clockwise" ? "Clockwise" : "Counterclockwise",
  };
}

/** Map regions for the circuit browser: each zooms the map and filters the
 * circuit cards, so Europe's cluster of a dozen pins becomes pickable. */
export type MapRegion = "world" | "europe" | "americas" | "middle-east" | "asia-pacific";

export const MAP_REGIONS: { id: MapRegion; label: string }[] = [
  { id: "world", label: "World" },
  { id: "europe", label: "Europe" },
  { id: "americas", label: "Americas" },
  { id: "middle-east", label: "Middle East" },
  { id: "asia-pacific", label: "Asia-Pacific" },
];

export function regionOf(meta: { lat: number; lon: number }): Exclude<MapRegion, "world"> {
  if (meta.lon < -30) return "americas";
  if (meta.lon >= 60) return "asia-pacific";
  if (meta.lon >= 35 || meta.lat < 34) return "middle-east";
  return "europe";
}

/** A view framing every pin in the region with a margin, at the map's
 * locked 2:1 aspect. */
export function regionView(tracks: readonly TrackMeta[], region: MapRegion): MapView {
  if (region === "world") return fullWorldView();
  const pins = tracks
    .filter((t) => regionOf(t) === region)
    .map((t) => projectPin(t.lat, t.lon, WORLD_MAP_W, WORLD_MAP_H));
  if (pins.length === 0) return fullWorldView();
  const minX = Math.min(...pins.map((p) => p.x));
  const maxX = Math.max(...pins.map((p) => p.x));
  const minY = Math.min(...pins.map((p) => p.y));
  const maxY = Math.max(...pins.map((p) => p.y));
  const w = Math.max((maxX - minX) * 1.35, (maxY - minY) * 1.35 * (WORLD_MAP_W / WORLD_MAP_H), MAP_MIN_ZOOM_W * 1.6);
  const h = viewH(w);
  return clampMapView({ w, x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2 });
}

export type LabelSide = "right" | "left" | "above" | "below";

/**
 * Greedy label placement for map pins: each label tries right, left, above
 * then below its pin and takes the first spot that overlaps no label
 * already placed (and no other pin); priority ids (the picked circuit, the
 * hovered one) place first and always get a spot. Sizes are in the same
 * units as the pin positions: charWidth per character, lineHeight tall.
 */
export function placeLabels(
  pins: { id: string; x: number; y: number; text: string }[],
  priority: readonly string[],
  charWidth: number,
  lineHeight: number,
  gap: number
): Map<string, LabelSide> {
  type Rect = { x0: number; y0: number; x1: number; y1: number };
  const placed: Rect[] = [];
  const out = new Map<string, LabelSide>();
  const hit = (r: Rect) =>
    placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0) ||
    pins.some((p) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1);
  const ordered = [
    ...pins.filter((p) => priority.includes(p.id)),
    ...pins.filter((p) => !priority.includes(p.id)),
  ];
  for (const pin of ordered) {
    const w = pin.text.length * charWidth;
    const h = lineHeight;
    const options: [LabelSide, Rect][] = [
      ["right", { x0: pin.x + gap, y0: pin.y - h / 2, x1: pin.x + gap + w, y1: pin.y + h / 2 }],
      ["left", { x0: pin.x - gap - w, y0: pin.y - h / 2, x1: pin.x - gap, y1: pin.y + h / 2 }],
      ["above", { x0: pin.x - w / 2, y0: pin.y - gap - h, x1: pin.x + w / 2, y1: pin.y - gap }],
      ["below", { x0: pin.x - w / 2, y0: pin.y + gap, x1: pin.x + w / 2, y1: pin.y + gap + h }],
    ];
    const free = options.find(([, r]) => !hit(r));
    const choice = free ?? (priority.includes(pin.id) ? options[0] : undefined);
    if (choice) {
      out.set(pin.id, choice[0]);
      placed.push(choice[1]);
    }
  }
  return out;
}
