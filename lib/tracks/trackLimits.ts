import type { TrackData } from "./types";
import {
  TRACK_EDGE_MARGIN_METERS,
  WORLD_EDGE_RESET_METERS,
} from "../physics/vehicle";

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

// Plan section 5, depth feature 6 (kerb & surface interaction) / section 4
// point 7 (surface zones): this track's data has no authored per-zone
// surface tags yet (asphalt/kerb/grass/gravel), so this approximates "how
// far into the grass" a car is using the same distanceFromEdgeMeters this
// module already computes for the off-track warning/invalidation above,
// rather than a second geometry system. Grip falls off smoothly over the
// first few meters past the edge (where real grass starts mattering) down
// to a harsh but still-drivable floor, instead of an instant on/off
// track-limits-style cliff - revisit with real per-zone grip/drag once the
// track pipeline authors them.
const SURFACE_GRIP_FALLOFF_METERS = 4;
const MIN_SURFACE_GRIP_FRACTION = 0.35;

/**
 * A below-1x-only grip multiplier for driving off the track surface -
 * follows the same "only ever shrinks an existing safe product" pattern as
 * the aero and tire compound grip scales in vehicle.ts/tireModel.ts, so it
 * composes with them without needing new stability verification.
 */
export function computeSurfaceGripMultiplier(distanceFromEdgeMeters: number): number {
  if (distanceFromEdgeMeters <= 0) return 1;
  const t = Math.min(1, distanceFromEdgeMeters / SURFACE_GRIP_FALLOFF_METERS);
  return 1 - t * (1 - MIN_SURFACE_GRIP_FRACTION);
}

/**
 * The real track-limits rule (plan section 5, depth feature 7): a lap is
 * only invalidated when ALL FOUR wheels are off the track, not the chassis
 * center - a single wheel still touching keeps the lap legal, same as real
 * regulations, and avoids penalizing a car that's mostly still on track
 * through a wide corner exit. This is deliberately stricter (and separate
 * from) the HUD's real-time "TRACK LIMITS" warning, which fires off the
 * chassis center via `checkTrackLimits` above as an earlier, softer caution.
 */
export function allWheelsOffTrack(
  track: TrackData,
  wheelPositions: { x: number; z: number }[]
): boolean {
  return wheelPositions.every((p) => checkTrackLimits(track, p.x, p.z).isOffTrack);
}

/**
 * Distance from the track's projection origin reached by its furthest
 * centerline point - the radius every point of the racing surface sits
 * inside. Used to size the two things that must contain the whole circuit:
 * the world-edge reset radius below and the built grass field (see
 * lib/tracks/terrain.ts).
 */
export function trackExtentMeters(track: TrackData): number {
  let extent = 0;
  for (let i = 0; i < track.centerline.length; i++) {
    const [x, , z] = track.centerline[i];
    const radius = Math.hypot(x, z);
    if (radius > extent) extent = radius;
  }
  return extent;
}

/**
 * Absolute-distance backstop for a car that has driven off the end of the
 * circuit entirely - see WORLD_EDGE_RESET_METERS and
 * TRACK_EDGE_MARGIN_METERS. Track-relative rather than a bare constant: the
 * guard exists to stop a car leaving the finite ground field, so a circuit
 * larger than the constant has to push the boundary out with it, or the
 * reset fires on ordinary racing surface.
 */
export function worldEdgeResetMeters(track: TrackData): number {
  return Math.max(
    WORLD_EDGE_RESET_METERS,
    trackExtentMeters(track) + TRACK_EDGE_MARGIN_METERS
  );
}
