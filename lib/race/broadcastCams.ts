import type { TrackData } from "../tracks/types";

export interface BroadcastCam {
  /** World-space eye position. */
  x: number;
  y: number;
  z: number;
  /** Lap-line-referenced position of the eye's own station, meters. */
  progressMeters: number;
}

// Plan section 9 (TV/broadcast): fixed trackside cameras cutting on car
// proximity - pure presentation, zero physics, zero new render cost. Stands
// are placed procedurally, not authored: elevated and offset alternately on
// both sides of the ribbon every few hundred meters, so every circuit gets
// full coverage with no per-track data. The eyes are fixed; the aim tracks
// the car live (see Scene.tsx), the way a broadcast camera pans to follow
// the action - a fixed aim point would frame empty asphalt whenever the
// car isn't exactly on it.
const CAM_SPACING_METERS = 250;
const CAM_MIN_COUNT = 6;
const CAM_LATERAL_METERS = 22;
const CAM_HEIGHT_METERS = 7;

/**
 * Deterministic per-track camera set: evenly spaced by lap distance (so
 * coverage never bunches), alternating sides for broadcast variety. Pure
 * geometry off the built centerline, computed once per session.
 */
export function buildBroadcastCams(track: TrackData): BroadcastCam[] {
  const n = track.centerline.length;
  const count = Math.max(
    CAM_MIN_COUNT,
    Math.round(track.lengthMeters / CAM_SPACING_METERS)
  );
  const cams: BroadcastCam[] = [];
  for (let k = 0; k < count; k++) {
    const i = Math.floor((k * n) / count) % n;
    const [x, y, z] = track.centerline[i];
    const [px, , pz] = track.centerline[(i - 1 + n) % n];
    const [nx, , nz] = track.centerline[(i + 1) % n];
    const tangentX = nx - px;
    const tangentZ = nz - pz;
    const len = Math.hypot(tangentX, tangentZ) || 1;
    const side = k % 2 === 0 ? 1 : -1;
    const eyeX = x + (-tangentZ / len) * CAM_LATERAL_METERS * side;
    const eyeZ = z + (tangentX / len) * CAM_LATERAL_METERS * side;
    cams.push({
      x: eyeX,
      y: y + CAM_HEIGHT_METERS,
      z: eyeZ,
      progressMeters: (i / n) * track.lengthMeters,
    });
  }
  return cams;
}

/**
 * The camera whose station is nearest ahead of the car (wrapping the lap
 * line), so cuts walk forward around the lap as it drives. Car progress
 * rises monotonically, so the selection flips exactly once per passing -
 * no hysteresis needed, and teleports/rewinds just cut.
 */
export function selectBroadcastCam(
  cams: BroadcastCam[],
  carProgressMeters: number,
  lapLengthMeters: number
): number {
  let best = 0;
  let bestGap = Infinity;
  for (let k = 0; k < cams.length; k++) {
    const gap =
      (((cams[k].progressMeters - carProgressMeters) % lapLengthMeters) +
        lapLengthMeters) %
      lapLengthMeters;
    if (gap < bestGap) {
      bestGap = gap;
      best = k;
    }
  }
  return best;
}
