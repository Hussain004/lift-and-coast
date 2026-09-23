import { bankedHeight } from "../tracks/banking";
import type { TrackData } from "../tracks/types";

// Plan section 7 (real grids): qualifying sets the order, and the race
// starts staggered - pole at the line, P2 a car length-plus behind -
// instead of the old side-by-side spawn. The behind car also needs its lap
// timer told (see startsBehindLine in lapTimer.ts) or the run up to the
// line records a bogus ~2s lap.
export const GRID_BEHIND_METERS = 8;

/** Lateral offset fraction both cars keep from their equal-start spots. */
export const GRID_OFFSET_FRACTION_OF_HALF_WIDTH = 0.35;

export interface GridSpawn {
  x: number;
  /** Ground elevation under the slot plus spawn clearance (see
   * SPAWN_CLEARANCE_METERS) - never a flat y=1, which buries back-grid cars
   * on tracks with elevation or a banked surface. */
  y: number;
  z: number;
  /** Heading aligned with the local centerline tangent at this grid slot. */
  headingRad: number;
  startsBehindLine: boolean;
}

/** Chassis spawn height above the track surface. */
export const SPAWN_CLEARANCE_METERS = 1;

interface CenterlineMetrics {
  segmentLengths: number[];
  cumulative: number[];
  totalLength: number;
}

interface GridStation {
  x: number;
  y: number;
  z: number;
  tangentX: number;
  tangentZ: number;
  width: number;
  stationMeters: number;
}

function centerlineMetrics(track: TrackData): CenterlineMetrics {
  const centerline = track.centerline;
  const n = centerline.length;
  const segmentLengths: number[] = new Array(n);
  const cumulative: number[] = new Array(n + 1);
  cumulative[0] = 0;
  for (let i = 0; i < n; i++) {
    const a = centerline[i];
    const b = centerline[(i + 1) % n];
    segmentLengths[i] = Math.hypot(b[0] - a[0], b[2] - a[2]);
    cumulative[i + 1] = cumulative[i] + segmentLengths[i];
  }
  return { segmentLengths, cumulative, totalLength: cumulative[n] || 1 };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Project the start position onto the closed centerline and return its arc station. */
function startStation(track: TrackData, metrics: CenterlineMetrics): number {
  const centerline = track.centerline;
  const n = centerline.length;
  const start = track.startPos;
  let nearest = 0;
  let nearestDistanceSq = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = centerline[i][0] - start.x;
    const dz = centerline[i][2] - start.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = i;
    }
  }

  const a = centerline[nearest];
  const b = centerline[(nearest + 1) % n];
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const lengthSq = dx * dx + dz * dz;
  const fraction = lengthSq > 1e-9
    ? clamp01(((start.x - a[0]) * dx + (start.z - a[2]) * dz) / lengthSq)
    : 0;
  return metrics.cumulative[nearest] + fraction * metrics.segmentLengths[nearest];
}

function stationAtDistance(
  track: TrackData,
  metrics: CenterlineMetrics,
  distance: number
): GridStation {
  const centerline = track.centerline;
  const n = centerline.length;
  let wrapped = distance % metrics.totalLength;
  if (wrapped < 0) wrapped += metrics.totalLength;

  // Find the segment containing the requested arc distance. The track is
  // only a few thousand points, but keeping this binary search makes grid
  // placement cheap even when every car asks for its own station.
  let low = 0;
  let high = n - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (metrics.cumulative[mid] <= wrapped) low = mid;
    else high = mid - 1;
  }
  const i = low;
  const next = (i + 1) % n;
  const segmentLength = metrics.segmentLengths[i];
  const fraction = segmentLength > 1e-9 ? (wrapped - metrics.cumulative[i]) / segmentLength : 0;
  const a = centerline[i];
  const b = centerline[next];
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dz) || 1;
  return {
    x: a[0] + dx * fraction,
    y: a[1] + (b[1] - a[1]) * fraction,
    z: a[2] + dz * fraction,
    tangentX: dx / length,
    tangentZ: dz / length,
    width: track.width[i] + (track.width[next] - track.width[i]) * fraction,
    // The built JSON's nominal length is the public lap-distance unit. The
    // polyline's summed segment length can differ by a few centimeters after
    // spline resampling, so convert the local arc distance into that unit
    // before handing it to the banking profile.
    stationMeters: (wrapped / metrics.totalLength) * track.lengthMeters,
  };
}

/**
 * Ground elevation (centerline y) under a world position. The optional
 * reference height is important at crossings: it makes the nearest arm of a
 * multi-level circuit win instead of an arm that merely happens to be close
 * in x/z.
 */
export function groundElevationAt(track: TrackData, x: number, z: number, y?: number): number {
  let best = 0;
  let bestSq = Infinity;
  for (const [cx, cy, cz] of track.centerline) {
    const distSq = (cx - x) ** 2 + (cz - z) ** 2 + (y !== undefined ? (cy - y) ** 2 : 0);
    if (distSq < bestSq) {
      bestSq = distSq;
      best = cy;
    }
  }
  return best;
}

/**
 * Spawn for a grid slot (0-based: slot 0 is pole). Rows are placed by
 * walking backward along the actual closed centerline, not by extruding a
 * straight tangent from the start point. The latter looks correct on a
 * straight but places the back of a full grid into the grass whenever the
 * start line is at the exit of a curve, which is exactly what happened on
 * Hungaroring's narrow, bending run to turn one.
 */
export function gridSlot(track: TrackData, slot: number): GridSpawn {
  const metrics = centerlineMetrics(track);
  const startDistance = startStation(track, metrics);
  const row = Math.ceil(Math.max(0, slot) / 2);
  const behind = row * GRID_BEHIND_METERS;
  const station = stationAtDistance(track, metrics, startDistance - behind);

  // Keep pole exactly on the authored start point. Every other row gets its
  // own local width and tangent, so a narrowing entry or a curved approach
  // cannot push a car beyond the ribbon.
  const lateralSign = slot === 0 ? 0 : slot % 2 === 0 ? -1 : 1;
  const halfWidth = station.width / 2;
  const lateralLimit = Math.max(0, halfWidth - 1.1);
  const lateral = lateralSign * Math.min(
    halfWidth * GRID_OFFSET_FRACTION_OF_HALF_WIDTH,
    lateralLimit
  );
  const rightX = -station.tangentZ;
  const rightZ = station.tangentX;
  const x = station.x + rightX * lateral;
  const z = station.z + rightZ * lateral;
  const surfaceY = bankedHeight(
    track.id,
    station.stationMeters,
    track.lengthMeters,
    station.y,
    lateral
  );

  // Preserve the authored pole point, including its historical x/z exactly.
  // Its y is still sampled from the local surface so the spawn clearance is
  // consistent with every other row.
  if (slot === 0) {
    return {
      x: track.startPos.x,
      z: track.startPos.z,
      y: groundElevationAt(track, track.startPos.x, track.startPos.z) + SPAWN_CLEARANCE_METERS,
      headingRad: track.startPos.headingRad,
      startsBehindLine: false,
    };
  }

  return {
    x,
    y: surfaceY + SPAWN_CLEARANCE_METERS,
    z,
    headingRad: Math.atan2(-station.tangentX, -station.tangentZ),
    startsBehindLine: true,
  };
}
