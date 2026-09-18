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
