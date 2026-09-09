import { describe, expect, it } from "vitest";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

// Offsets purely along the local perpendicular (right) direction at a
// centerline index, derived from its neighbors - a fixed world-axis offset
// isn't reliable on a curved track, since it can drift along the track's
// own direction instead of away from it.
function pointAtLateralOffset(index: number, lateralMeters: number) {
  const n = track.centerline.length;
  const [x, , z] = track.centerline[index];
  const [px, , pz] = track.centerline[(index - 1 + n) % n];
  const [nx, , nz] = track.centerline[(index + 1) % n];
  const tangentX = nx - px;
  const tangentZ = nz - pz;
  const tangentLen = Math.hypot(tangentX, tangentZ) || 1;
  const rightX = -tangentZ / tangentLen;
  const rightZ = tangentX / tangentLen;
  return { x: x + rightX * lateralMeters, z: z + rightZ * lateralMeters };
}

describe("checkTrackLimits", () => {
  it("reports on-track at the start position", () => {
    const status = checkTrackLimits(track, track.startPos.x, track.startPos.z);
    expect(status.isOffTrack).toBe(false);
    expect(status.distanceFromEdgeMeters).toBe(0);
  });

  it("reports on-track near the centerline but off-center", () => {
    const halfWidth = track.width[100] / 2;
    const p = pointAtLateralOffset(100, halfWidth * 0.9);
    const status = checkTrackLimits(track, p.x, p.z);
    expect(status.isOffTrack).toBe(false);
  });

  it("reports off-track well past the edge", () => {
    const halfWidth = track.width[100] / 2;
    const p = pointAtLateralOffset(100, halfWidth + 20);
    const status = checkTrackLimits(track, p.x, p.z);
    expect(status.isOffTrack).toBe(true);
    expect(status.distanceFromEdgeMeters).toBeGreaterThan(15);
  });

  it("distance grows the further off-track the car gets", () => {
    const halfWidth = track.width[500] / 2;
    const near = pointAtLateralOffset(500, halfWidth + 2);
    const far = pointAtLateralOffset(500, halfWidth + 10);
    const nearStatus = checkTrackLimits(track, near.x, near.z);
    const farStatus = checkTrackLimits(track, far.x, far.z);
    expect(farStatus.distanceFromEdgeMeters).toBeGreaterThan(nearStatus.distanceFromEdgeMeters);
  });
});
