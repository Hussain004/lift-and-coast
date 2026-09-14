import type { TrackData } from "./types";

export interface TrackLimitStatus {
  /** 0 if within the track's width, meters past the edge otherwise. */
  distanceFromEdgeMeters: number;
  isOffTrack: boolean;
  /**
   * Arc-length distance along the centerline from the start/finish line to
   * the nearest centerline point, in meters - the same nearest-point search
   * this function already does, exposed for the delta timer (see
   * lib/race/deltaTimer.ts) instead of a second brute-force scan per frame.
   * Wraps to ~0 at the start/finish line, since track.centerline[0] is
   * startPos (verified against the real track data).
   */
  progressMeters: number;
}

/**
 * Brute-force nearest centerline point. At 2946 points and one call per
 * rendered frame this is a few hundred thousand simple ops/sec - trivial
 * for a single car. Revisit with a spatial index if many AI cars need this
 * simultaneously (plan section 6).
 */
export function checkTrackLimits(track: TrackData, x: number, z: number): TrackLimitStatus {
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < track.centerline.length; i++) {
    const [cx, , cz] = track.centerline[i];
    const distSq = (cx - x) ** 2 + (cz - z) ** 2;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  const halfWidth = track.width[nearestIdx] / 2;
  const distanceFromEdgeMeters = Math.max(0, Math.sqrt(nearestDistSq) - halfWidth);
  const progressMeters = (nearestIdx / track.centerline.length) * track.lengthMeters;
  return { distanceFromEdgeMeters, isOffTrack: distanceFromEdgeMeters > 0, progressMeters };
}
