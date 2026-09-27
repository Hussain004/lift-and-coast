import type { TrackData } from "../tracks/types";
import { checkTrackLimits, type TrackLimitStatus } from "../tracks/trackLimits";
import type { TrackEdgeGuard } from "./pathFollower";

/**
 * Track-edge awareness for the AI, wired to real track geometry.
 *
 * The control law and its opt-in guard live in pathFollower.ts, which
 * deliberately knows nothing about tracks - it is handed a racing line and a
 * position. This module is the seam: the only place that turns "a car is
 * somewhere" into "how much asphalt is left on the side it is on", using
 * checkTrackLimits so the answer comes from exactly the same nearest-point
 * rule the rest of the game uses for track limits, progress and surfaces.
 *
 * Returning undefined is the inert case and is honoured everywhere: the
 * controller then runs its reference control law unchanged.
 */

/**
 * Circuits where the guard is switched off.
 *
 * Suzuka is the only one, and it is excluded on evidence rather than taste.
 * The guard is measurably safe and useful almost everywhere - it cuts the
 * worst off-track excursion on 12 of 30 circuits (Silverstone 2.37m ->
 * 1.91m, Spa 3.33m -> 2.42m, COTA 2.67m -> 2.18m) and never costs distance.
 * But Suzuka's bridge crossover is a documented knife edge for this control
 * law, and the guard is no exception: a sweep of eight gain/activation
 * packages found only ONE safe (tilt 0.40rad) among values that otherwise
 * flipped at 0.63-1.63rad, and non-monotonically - halving the gain from
 * 0.12 to 0.06 was safe, halving it again to 0.03 flipped. That is a lottery,
 * not a tuning curve, and this codebase has already been bitten twice on
 * Suzuka by exactly this pattern (the boost deployment margin in
 * pathFollower.ts's own header, and the gearbox rev-axis rescale). Shipping
 * the one value that happened to pass would be superstition.
 *
 * So the guard stays off here and Suzuka keeps its existing 2.78m worst
 * excursion, comfortably inside the 6m gate. What would actually earn this
 * circuit the guard is margin in the underlying control law, not another
 * number to sweep.
 */
export const EDGE_GUARD_DISABLED_TRACK_IDS: ReadonlySet<string> = new Set(["suzuka"]);

export function edgeGuardEnabledForTrack(trackId: string): boolean {
  return !EDGE_GUARD_DISABLED_TRACK_IDS.has(trackId);
}

/**
 * The guard for a car's current position, or undefined when it should not
 * apply (disabled circuit, or an unusable limit reading). `status` is the
 * caller's existing checkTrackLimits result if it already has one - the AI
 * car computes it every tick anyway for track limits, so passing it in keeps
 * this free rather than a second nearest-point scan per car per tick.
 */
export function buildTrackEdgeGuard(
  track: TrackData,
  x: number,
  z: number,
  y: number,
  status?: TrackLimitStatus
): TrackEdgeGuard | undefined {
  if (!edgeGuardEnabledForTrack(track.id)) return undefined;
  const st = status ?? checkTrackLimits(track, x, z, y);
  const halfWidth = track.width[st.nearestIndex] / 2;
  if (!Number.isFinite(halfWidth) || halfWidth <= 0) return undefined;
  const lateral = st.lateralMeters;
  if (!Number.isFinite(lateral)) return undefined;
  return {
    // Positive = asphalt left between the car and the edge on its own side.
    roomMeters: halfWidth - Math.abs(lateral),
    // checkTrackLimits reports positive lateral for the right of the
    // centerline, matching the sign the controller's steering law expects.
    side: lateral < 0 ? -1 : 1,
  };
}
