// Geometry for the drivable pit lane (see pitLane.ts): asphalt, painted
// lines, the pit wall, the garage row and the player's box. Everything is
// flat-shaded quads with vertex colours, so the whole pit complex is four
// draw calls. Visual only - the physics treats the lane as road through
// checkTrackLimits and drives on the terrain beneath it.
import { PIT_BOX_HALF_LENGTH, PIT_LANE_HALF_WIDTH, type PitLane } from "./pitLane";
import type { TrackData } from "./types";

export interface PitMesh {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

interface Builder {
  positions: number[];
  colors: number[];
  indices: number[];
}

type V3 = [number, number, number];

function hexToRgb(hex: string): V3 {
  const n = parseInt(hex.slice(1), 16);
  // Vertex colours are read as linear by the shared surface material, like
  // the rest of the circuit geometry.
  const lin = (c: number) => Math.pow(c / 255, 2.2);
  return [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
}

function quad(b: Builder, a: V3, c: V3, d: V3, e: V3, color: V3): void {
  const base = b.positions.length / 3;
  for (const v of [a, c, d, e]) {
    b.positions.push(v[0], v[1], v[2]);
    b.colors.push(color[0], color[1], color[2]);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function finish(b: Builder): PitMesh {
  return {
    positions: new Float32Array(b.positions),
    colors: new Float32Array(b.colors),
    indices: new Uint32Array(b.indices),
  };
}

export interface PitLaneMeshes {
  asphalt: PitMesh;
  paint: PitMesh;
  walls: PitMesh;
  garages: PitMesh;
}

/** Livery-ish door colours; the row reads as a paddock, not a fence. */
const DOOR_COLORS = ["#1e4fa8", "#d7263d", "#e8e8ea", "#23a37a", "#f28f1c", "#6a3fb5", "#121216", "#3aa0d8", "#b01e2b", "#c9c9d0"];
const DOOR_PITCH_METERS = 13;
const DOOR_WIDTH_METERS = 9;
const GARAGE_HEIGHT = 4.2;
const GARAGE_DEPTH = 6.5;
const WALL_HEIGHT = 1.0;
const WALL_HALF_THICKNESS = 0.22;

export function buildPitLaneMeshes(track: TrackData, lane: PitLane): PitLaneMeshes {
  const n = track.centerline.length;
  const spacing = track.lengthMeters / n;
  const asphalt: Builder = { positions: [], colors: [], indices: [] };
  const paint: Builder = { positions: [], colors: [], indices: [] };
  const walls: Builder = { positions: [], colors: [], indices: [] };
  const garages: Builder = { positions: [], colors: [], indices: [] };

  const right = (i: number): [number, number] => {
    const before = track.centerline[(i - 1 + n) % n];
    const after = track.centerline[(i + 1) % n];
    const tx = after[0] - before[0];
    const tz = after[2] - before[2];
    const len = Math.hypot(tx, tz) || 1;
    return [-tz / len, tx / len];
  };
  /** World point at lateral `offset` from the centreline (right +) and height above the lane. */
  const at = (k: number, offset: number, h: number): V3 => {
    const i = lane.indices[k];
    const c = track.centerline[i];
    const [rx, rz] = right(i);
    return [c[0] + rx * offset, c[1] + h, c[2] + rz * offset];
  };
  /** A point `frac` of the way from lane point k to k+1 (lateral offset given from the centreline). */
  const atFrac = (k: number, frac: number, offset: number, h: number): V3 => {
    const a = at(k, offset, h);
    const b = at(k + 1, offset, h);
    return [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac, a[2] + (b[2] - a[2]) * frac];
  };
  const centreOffset = (k: number) => lane.offsetByIndex[lane.indices[k]];
  const gap = (k: number) => lane.gapByIndex[lane.indices[k]];
  const asphaltColor = hexToRgb("#4a4c52");
  const lineColor = hexToRgb("#f2f2f2");
  const wallColor = hexToRgb("#c4c7cd");
  const wallTop = hexToRgb("#e6e8ec");
  const buildingColor = hexToRgb("#cfd2d8");
  const roofColor = hexToRgb("#2a2c33");

  for (let k = 0; k + 1 < lane.points.length; k++) {
    const o0 = centreOffset(k);
    const o1 = centreOffset(k + 1);
    // Asphalt with a hair of height so it wins over the grass under it and
    // the track ribbon it merges into.
    quad(
      asphalt,
      at(k, o0 - PIT_LANE_HALF_WIDTH, 0.045),
      at(k, o0 + PIT_LANE_HALF_WIDTH, 0.045),
      at(k + 1, o1 + PIT_LANE_HALF_WIDTH, 0.045),
      at(k + 1, o1 - PIT_LANE_HALF_WIDTH, 0.045),
      asphaltColor
    );
    // Painted lane edges.
    for (const side of [-1, 1]) {
      const e = PIT_LANE_HALF_WIDTH - 0.25;
      const w = 0.16;
      quad(
        paint,
        at(k, o0 + side * (e - w), 0.06),
        at(k, o0 + side * (e + w), 0.06),
        at(k + 1, o1 + side * (e + w), 0.06),
        at(k + 1, o1 + side * (e - w), 0.06),
        lineColor
      );
    }
    const g0 = gap(k);
    const g1 = gap(k + 1);
    // The pit wall between track and lane, only where the lane has left the
    // track (the ramps stay open).
    if (g0 >= 4.5 && g1 >= 4.5) {
      const half0 = track.width[lane.indices[k]] / 2;
      const half1 = track.width[lane.indices[k + 1]] / 2;
      const w0 = lane.sign * (half0 + 2.4);
      const w1 = lane.sign * (half1 + 2.4);
      const t = WALL_HALF_THICKNESS;
      quad(walls, at(k, w0 - t, WALL_HEIGHT), at(k, w0 + t, WALL_HEIGHT), at(k + 1, w1 + t, WALL_HEIGHT), at(k + 1, w1 - t, WALL_HEIGHT), wallTop);
      quad(walls, at(k, w0 - t, 0), at(k, w0 - t, WALL_HEIGHT), at(k + 1, w1 - t, WALL_HEIGHT), at(k + 1, w1 - t, 0), wallColor);
      quad(walls, at(k, w0 + t, 0), at(k, w0 + t, WALL_HEIGHT), at(k + 1, w1 + t, WALL_HEIGHT), at(k + 1, w1 + t, 0), wallColor);
    }
    // The garage row on the far side of the lane.
    if (g0 >= 7.5 && g1 >= 7.5) {
      const half0 = track.width[lane.indices[k]] / 2;
      const half1 = track.width[lane.indices[k + 1]] / 2;
      const f0 = lane.sign * (half0 + g0 + PIT_LANE_HALF_WIDTH + 0.7);
      const f1 = lane.sign * (half1 + g1 + PIT_LANE_HALF_WIDTH + 0.7);
      const d0 = f0 + lane.sign * GARAGE_DEPTH;
      const d1 = f1 + lane.sign * GARAGE_DEPTH;
      quad(garages, at(k, f0, 0), at(k, f0, GARAGE_HEIGHT), at(k + 1, f1, GARAGE_HEIGHT), at(k + 1, f1, 0), buildingColor);
      quad(garages, at(k, f0, GARAGE_HEIGHT), at(k, d0, GARAGE_HEIGHT), at(k + 1, d1, GARAGE_HEIGHT), at(k + 1, f1, GARAGE_HEIGHT), roofColor);
    }
  }

  // Garage doors: dark openings with a team-colour header, every 13 m.
  const doorK = Math.max(1, Math.round(DOOR_PITCH_METERS / spacing));
  const doorSpan = Math.max(1, Math.round(DOOR_WIDTH_METERS / spacing));
  let doorNumber = 0;
  for (let k = 0; k + doorSpan < lane.points.length; k += doorK) {
    if (gap(k) < 7.5 || gap(k + doorSpan) < 7.5) continue;
    const half = track.width[lane.indices[k]] / 2;
    const face = lane.sign * (half + gap(k) + PIT_LANE_HALF_WIDTH + 0.7 - 0.06);
    const face2 = lane.sign * (track.width[lane.indices[k + doorSpan]] / 2 + gap(k + doorSpan) + PIT_LANE_HALF_WIDTH + 0.7 - 0.06);
    const header = hexToRgb(DOOR_COLORS[doorNumber % DOOR_COLORS.length]);
    quad(garages, at(k, face, 0), at(k, face, 3.0), at(k + doorSpan, face2, 3.0), at(k + doorSpan, face2, 0), hexToRgb("#15161a"));
    quad(garages, at(k, face, 3.0), at(k, face, 3.7), at(k + doorSpan, face2, 3.7), at(k + doorSpan, face2, 3.0), header);
    doorNumber++;
  }

  // Entry and exit lines across the lane where the limiter starts and ends.
  const line = (k: number) => {
    const o = centreOffset(k);
    quad(paint, at(k, o - PIT_LANE_HALF_WIDTH, 0.065), at(k, o + PIT_LANE_HALF_WIDTH, 0.065), atFrac(k, 0.2, o + PIT_LANE_HALF_WIDTH, 0.065), atFrac(k, 0.2, o - PIT_LANE_HALF_WIDTH, 0.065), lineColor);
  };
  let entryK = 0;
  while (entryK < lane.points.length - 2 && gap(entryK) < 1) entryK++;
  let exitK = lane.points.length - 3;
  while (exitK > 0 && gap(exitK) < 1) exitK--;
  line(entryK);
  line(exitK);

  // The player's box: a green outline, a car's length long.
  const bk = lane.indices.indexOf(lane.box.index);
  const boxSpan = Math.max(1, Math.round((PIT_BOX_HALF_LENGTH * 2) / spacing));
  const boxColor = hexToRgb("#33d17a");
  const bo = centreOffset(bk);
  const bw = 1.7;
  const t = 0.09;
  const k0 = Math.max(0, bk - Math.floor(boxSpan / 2));
  const k1 = Math.min(lane.points.length - 2, k0 + boxSpan);
  for (let k = k0; k < k1; k++) {
    for (const side of [-1, 1]) {
      quad(paint, at(k, bo + side * (bw - t), 0.07), at(k, bo + side * (bw + t), 0.07), at(k + 1, bo + side * (bw + t), 0.07), at(k + 1, bo + side * (bw - t), 0.07), boxColor);
    }
  }
  for (const k of [k0, k1]) {
    quad(paint, at(k, bo - bw, 0.07), at(k, bo + bw, 0.07), atFrac(k, 0.12, bo + bw, 0.07), atFrac(k, 0.12, bo - bw, 0.07), boxColor);
  }

  return { asphalt: finish(asphalt), paint: finish(paint), walls: finish(walls), garages: finish(garages) };
}
