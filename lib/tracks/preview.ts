// Plan section 8 (Track Preview): menu-safe circuit outlines and the pure
// math that draws them. The race route's per-track JSON is ~550KB of
// centerline the menu bundle must never import (see lib/tracks/registry.ts),
// so scripts/build-track.mts emits the tiny data/tracks/outlines.json
// sidecar instead - a stride-sampled top-down outline plus the facts the
// preview prints - and everything here works from that plus the registry.
import outlinesData from "../../data/tracks/outlines.json";
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
