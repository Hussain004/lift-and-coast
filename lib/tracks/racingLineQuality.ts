import { MAX_ACCEL_MS2, MAX_DECEL_MS2, type RacingLinePoint, type ThrottleZone } from "./racingLine";
import type { TrackData } from "./types";

export interface RacingLineQuality {
  lengthMeters: number;
  theoreticalLapSeconds: number;
  minimumEdgeMarginMeters: number;
  maximumCurvature: number;
  p95Curvature: number;
  maximumRequiredDeceleration: number;
  maximumRequiredAcceleration: number;
  zoneCounts: Record<ThrottleZone, number>;
  shortestZoneRunPoints: number;
}

function unitTangent(a: readonly [number, number, number], b: readonly [number, number, number]) {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const length = Math.hypot(dx, dz) || 1;
  return { x: dx / length, z: dz / length };
}

/**
 * Pure, deterministic quality metrics for a generated line. This is kept
 * separate from the renderer so a line can be checked in CI or a benchmark
 * without a WebGL context. The speed limits are the same constants used to
 * build the profile, making this a feasibility check rather than a second
 * hidden tuning model.
 */
export function analyzeRacingLine(track: TrackData, line: RacingLinePoint[]): RacingLineQuality {
  const n = line.length;
  const zoneCounts: Record<ThrottleZone, number> = {
    throttle: 0,
    lift: 0,
    "brake-medium": 0,
    "brake-hard": 0,
  };
  const curvatures: number[] = [];
  let lengthMeters = 0;
  let theoreticalLapSeconds = 0;
  let minimumEdgeMarginMeters = Infinity;
  let maximumRequiredDeceleration = 0;
  let maximumRequiredAcceleration = 0;

  for (let i = 0; i < n; i++) {
    const previous = line[(i - 1 + n) % n].position;
    const current = line[i].position;
    const next = line[(i + 1) % n].position;
    const incoming = unitTangent(previous, current);
    const outgoing = unitTangent(current, next);
    const turn = Math.abs(
      Math.atan2(incoming.x * outgoing.z - incoming.z * outgoing.x, incoming.x * outgoing.x + incoming.z * outgoing.z)
    );
    const segment = line[i].distanceToNextMeters;
    const curvature = turn / Math.max(0.1, segment);
    curvatures.push(curvature);
    lengthMeters += segment;
    theoreticalLapSeconds += segment / Math.max(1, (line[i].targetSpeedMs + line[(i + 1) % n].targetSpeedMs) * 0.5);

    const tangent = unitTangent(track.centerline[(i - 1 + track.centerline.length) % track.centerline.length], track.centerline[(i + 1) % track.centerline.length]);
    const rightX = -tangent.z;
    const rightZ = tangent.x;
    const center = track.centerline[i];
    const lateral = (current[0] - center[0]) * rightX + (current[2] - center[2]) * rightZ;
    minimumEdgeMarginMeters = Math.min(
      minimumEdgeMarginMeters,
      track.width[i] / 2 - Math.abs(lateral)
    );

    const nextSpeed = line[(i + 1) % n].targetSpeedMs;
    const speed = line[i].targetSpeedMs;
    maximumRequiredDeceleration = Math.max(
      maximumRequiredDeceleration,
      (speed * speed - nextSpeed * nextSpeed) / (2 * Math.max(0.1, segment))
    );
    maximumRequiredAcceleration = Math.max(
      maximumRequiredAcceleration,
      (nextSpeed * nextSpeed - speed * speed) / (2 * Math.max(0.1, segment))
    );
    zoneCounts[line[i].zone]++;
  }

  curvatures.sort((a, b) => a - b);
  let shortestZoneRunPoints = n;
  let run = 1;
  for (let i = 1; i <= n; i++) {
    if (line[i % n].zone === line[(i - 1) % n].zone) {
      run++;
    } else {
      shortestZoneRunPoints = Math.min(shortestZoneRunPoints, run);
      run = 1;
    }
  }

  return {
    lengthMeters,
    theoreticalLapSeconds,
    minimumEdgeMarginMeters,
    maximumCurvature: curvatures[curvatures.length - 1] ?? 0,
    p95Curvature: curvatures[Math.floor(curvatures.length * 0.95)] ?? 0,
    maximumRequiredDeceleration: Math.max(0, maximumRequiredDeceleration),
    maximumRequiredAcceleration: Math.max(0, maximumRequiredAcceleration),
    zoneCounts,
    shortestZoneRunPoints,
  };
}

export const RACING_LINE_ACCELERATION_LIMIT = MAX_ACCEL_MS2;
export const RACING_LINE_DECELERATION_LIMIT = MAX_DECEL_MS2;
