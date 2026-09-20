// Per-car progress continuity (plan section 7 timing): checkTrackLimits
// scans the whole centerline every tick, and at the start/finish seam
// that scan is knife-edge - indices 0 and len-1 sit meters apart in
// space, so a car parked or rolling near the line flickers between
// progress ~0 and ~trackLength. That flicker slingshots the tower
// (P1 one tick, P20 the next) and phantom-triggers AI gap logic. This
// tracker prefers continuity: once seeded it only searches a window
// around last tick's index (the seam is adjacent in index space, so
// crossings stay continuous), falling back to a global scan only on a
// genuine teleport (resets, rewinds beyond the window). As a bonus the
// window scan is ~25x cheaper than the full one per car per tick.
import type { TrackData } from "../tracks/types";

/** Points either side of last tick's index to search. */
const SEARCH_WINDOW_POINTS = 60;
/** Beyond this distance the car must have teleported: rescan globally. */
const TELEPORT_METERS = 50;

export interface ProgressTracker {
  index: number | null;
}

export function createProgressTracker(): ProgressTracker {
  return { index: null };
}

function distSqTo(track: TrackData, i: number, x: number, z: number): number {
  const n = track.centerline.length;
  const p = track.centerline[((i % n) + n) % n];
  return (p[0] - x) ** 2 + (p[2] - z) ** 2;
}

/**
 * Continuous progress meters for (x, z): same (index/length)*trackLength
 * contract as checkTrackLimits' progressMeters, but stable across the
 * seam. Returns the nearest index too, for callers that anchor line
 * scans to it. Mutates (and returns) the tracker.
 */
export function trackProgress(
  track: TrackData,
  x: number,
  z: number,
  tracker: ProgressTracker
): { progressMeters: number; nearestIndex: number; teleported: boolean } {
  const n = track.centerline.length;
  if (tracker.index === null) {
    let best = 0;
    let bestSq = Infinity;
    for (let i = 0; i < n; i++) {
      const d = distSqTo(track, i, x, z);
      if (d < bestSq) {
        bestSq = d;
        best = i;
      }
    }
    tracker.index = best;
    return { progressMeters: (best / n) * track.lengthMeters, nearestIndex: best, teleported: true };
  }
  let best = tracker.index;
  let bestSq = distSqTo(track, best, x, z);
  for (let k = 1; k <= SEARCH_WINDOW_POINTS; k++) {
    for (const i of [tracker.index - k, tracker.index + k]) {
      const d = distSqTo(track, i, x, z);
      if (d < bestSq) {
        bestSq = d;
        best = ((i % n) + n) % n;
      }
    }
  }
  if (bestSq > TELEPORT_METERS * TELEPORT_METERS) {
    const fresh = trackProgress(track, x, z, { index: null });
    tracker.index = fresh.nearestIndex;
    return fresh;
  }
  tracker.index = best;
  return { progressMeters: (best / n) * track.lengthMeters, nearestIndex: best, teleported: false };
}
