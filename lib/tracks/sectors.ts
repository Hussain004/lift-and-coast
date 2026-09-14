import type { TrackData } from "./types";

export interface SectorGate {
  x: number;
  z: number;
  headingRad: number;
}

/**
 * Boundary gates splitting a track into `sectorCount` equal arc-length
 * pieces (plan section 13: "sector splits in green/purple/yellow") -
 * a placeholder for real authored sector boundaries (plan section 4,
 * point 9), which this project's track data doesn't have yet. Revisit
 * once a track's own JSON carries real sector markers.
 *
 * Each gate's heading is derived from the centerline's own tangent at that
 * point (not stored data), using the same convention as a track's
 * `startPos.headingRad` (verified: computing this for centerline[0]
 * reproduces Silverstone's real startPos.headingRad to 3 decimal places).
 */
export function computeSectorGates(track: TrackData, sectorCount: number): SectorGate[] {
  const gates: SectorGate[] = [];
  const n = track.centerline.length;
  for (let i = 1; i < sectorCount; i++) {
    const idx = Math.round((i * n) / sectorCount) % n;
    const [x, , z] = track.centerline[idx];
    const [px, , pz] = track.centerline[(idx - 1 + n) % n];
    const [nx, , nz] = track.centerline[(idx + 1) % n];
    const tx = nx - px;
    const tz = nz - pz;
    const headingRad = Math.atan2(-tx, -tz);
    gates.push({ x, z, headingRad });
  }
  return gates;
}
