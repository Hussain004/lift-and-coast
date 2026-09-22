import type { TrackData } from "./types";
import type { RacingLinePoint } from "./racingLine";
import { computeRacingLine } from "./racingLine";

// computeRacingLine is an O(n) two-pass optimization over 1,700-3,000
// centerline points, and its output depends only on the track geometry.
// Before this cache, every AICar instance computed it on mount (plus one
// more in Track.tsx for the visible ribbon) - 21 identical computations
// per race load. The line array is shared read-only: no consumer mutates
// points (they write derived values into their own buffers), so one
// instance serves the whole scene.
const racingLineCache = new WeakMap<TrackData, RacingLinePoint[]>();

/**
 * The (shared, read-only) ideal racing line for a track, computed on
 * first request and reused by every AICar, the Track ribbon and tests
 * thereafter. Semantically identical to calling computeRacingLine
 * directly - same pure function underneath - just computed once per
 * track object instead of once per consumer.
 */
export function getRacingLine(track: TrackData): RacingLinePoint[] {
  let line = racingLineCache.get(track);
  if (!line) {
    line = computeRacingLine(track);
    racingLineCache.set(track, line);
  }
  return line;
}