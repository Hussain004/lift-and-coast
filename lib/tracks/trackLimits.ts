import type { TrackData } from "./types";

export interface TrackLimitStatus {
  /** 0 if within the track's width, meters past the edge otherwise. */
  distanceFromEdgeMeters: number;
  isOffTrack: boolean;
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
  return { distanceFromEdgeMeters, isOffTrack: distanceFromEdgeMeters > 0 };
}
