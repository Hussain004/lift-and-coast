// Night-race floodlight positions: masts along the circuit on alternating
// sides, set back from the edge. Pure; app/race/NightLights.tsx draws the
// masts and lights the few nearest the player (see nearestLamps).
import type { TrackData } from "./types";

export interface Lamp {
  x: number;
  /** Road height at the mast's foot. */
  y: number;
  z: number;
}

export const LAMP_SPACING_METERS = 90;
/** Metres from the track edge to the mast. */
export const LAMP_SETBACK_METERS = 9;
export const LAMP_HEIGHT_METERS = 15;
/** No mast closer than this to the edge of any road, its own or another stretch. */
const MIN_ROAD_CLEARANCE_METERS = 5;

/** A mast every ~LAMP_SPACING_METERS of arc length, alternating left and right. */
export function computeFloodlights(track: TrackData, spacing = LAMP_SPACING_METERS): Lamp[] {
  const n = track.centerline.length;
  if (n < 4) return [];
  const lamps: Lamp[] = [];
  let sinceLast = spacing; // one at the start line
  let side = 1;
  for (let i = 0; i < n; i++) {
    const a = track.centerline[i];
    const b = track.centerline[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const step = Math.hypot(dx, dz);
    if (step < 1e-6) continue;
    if (sinceLast >= spacing) {
      sinceLast = 0;
      // Left of travel is (dz, -dx)/len in this projection; the sign only flips sides.
      const off = (track.width[i] ?? 12) / 2 + LAMP_SETBACK_METERS;
      const lamp = { x: a[0] + (dz / step) * off * side, y: a[1], z: a[2] - (dx / step) * off * side };
      side = -side;
      // A hairpin or a parallel straight can put the mast on another stretch of road: skip it.
      if (clearOfRoad(track, lamp)) lamps.push(lamp);
    }
    sinceLast += step;
  }
  return lamps;
}

function clearOfRoad(track: TrackData, lamp: Lamp): boolean {
  for (let i = 0; i < track.centerline.length; i++) {
    const c = track.centerline[i];
    const reach = (track.width[i] ?? 12) / 2 + MIN_ROAD_CLEARANCE_METERS;
    if (Math.abs(c[0] - lamp.x) < reach && Math.abs(c[2] - lamp.z) < reach && Math.hypot(c[0] - lamp.x, c[2] - lamp.z) < reach) return false;
  }
  return true;
}

/** Indices of the `count` lamps nearest (x, z), nearest first. */
export function nearestLamps(lamps: readonly Lamp[], x: number, z: number, count: number): number[] {
  return lamps
    .map((lamp, i) => ({ i, d: (lamp.x - x) ** 2 + (lamp.z - z) ** 2 }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((e) => e.i);
}
