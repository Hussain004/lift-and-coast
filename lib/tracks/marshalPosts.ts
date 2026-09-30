// Marshal posts: a small hut and flag pole every ~MARSHAL_SPACING_METERS just
// behind the barrier, on alternating sides. Pure; app/race/MarshalPosts.tsx
// draws them and waves a yellow flag on the posts that cover an incident.
import type { TrackData } from "./types";
import { barrierProfileForTrack } from "./environment";

export interface MarshalPost {
  x: number;
  /** Road height beside the post (the caller may re-seat it on the terrain). */
  y: number;
  z: number;
  /** Yaw so the hut's door faces the track. */
  yawRad: number;
  /** Distance along the lap at the post, metres. */
  stationMeters: number;
}

export const MARSHAL_SPACING_METERS = 260;
/** Metres past the barrier's inside face; the slab's own depth is added on top. */
const BEHIND_BARRIER_METERS = 3;
/** The pit straight is lined with garages and pit buildings, not marshals. */
const SKIP_AROUND_START_METERS = 340;

export function computeMarshalPosts(track: TrackData, spacing = MARSHAL_SPACING_METERS): MarshalPost[] {
  const n = track.centerline.length;
  if (n < 4) return [];
  const barrier = barrierProfileForTrack(track.id);
  const posts: MarshalPost[] = [];
  let station = 0;
  let nextAt = spacing / 2;
  let side = 1;
  for (let i = 0; i < n; i++) {
    const a = track.centerline[i];
    const b = track.centerline[(i + 1) % n];
    const dx = b[0] - a[0];
    const dz = b[2] - a[2];
    const step = Math.hypot(dx, dz);
    if (step < 1e-6) continue;
    if (station >= nextAt) {
      nextAt += spacing;
      const fx = dx / step;
      const fz = dz / step;
      const off = (track.width[i] ?? 12) / 2 + barrier.setbackMeters + barrier.halfThicknessMeters * 2 + BEHIND_BARRIER_METERS;
      // Left of travel is (fz, -fx) in this projection; the sign only flips sides.
      const post: MarshalPost = {
        x: a[0] + fz * off * side,
        y: a[1],
        z: a[2] - fx * off * side,
        yawRad: Math.atan2(-fz * side, fx * side),
        stationMeters: station,
      };
      side = -side;
      const nearStart = station < SKIP_AROUND_START_METERS || station > track.lengthMeters - SKIP_AROUND_START_METERS;
      if (!nearStart && clearOfRoad(track, post, barrier.setbackMeters + 1)) posts.push(post);
    }
    station += step;
  }
  return posts;
}

/** Beyond the barrier's inside face of EVERY stretch of road, not just its own. */
function clearOfRoad(track: TrackData, post: MarshalPost, setback: number): boolean {
  for (let i = 0; i < track.centerline.length; i++) {
    const c = track.centerline[i];
    const reach = (track.width[i] ?? 12) / 2 + setback;
    if (Math.hypot(c[0] - post.x, c[2] - post.z) < reach) return false;
  }
  return true;
}

/** How far before the incident a post still waves its yellow. */
export const YELLOW_STRETCH_BEFORE_METERS = 400;
/** ...and how far past it (the post beside the car itself). */
export const YELLOW_STRETCH_AFTER_METERS = 20;

/**
 * Whether the post at `stationMeters` shows yellow for an incident at
 * `incidentMeters` (negative = none). Wraps across the start line.
 */
export function postShowsYellow(stationMeters: number, incidentMeters: number, lapMeters: number): boolean {
  if (incidentMeters < 0) return false;
  let ahead = (incidentMeters - stationMeters) % lapMeters;
  if (ahead < 0) ahead += lapMeters;
  return ahead <= YELLOW_STRETCH_BEFORE_METERS || ahead >= lapMeters - YELLOW_STRETCH_AFTER_METERS;
}
