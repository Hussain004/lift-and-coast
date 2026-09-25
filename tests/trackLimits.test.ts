import { describe, expect, it } from "vitest";
import {
  allWheelsOffTrack,
  checkTrackLimits,
  trackExtentMeters,
  worldEdgeResetMeters,
} from "../lib/tracks/trackLimits";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import {
  TRACK_EDGE_MARGIN_METERS,
  WORLD_EDGE_RESET_METERS,
} from "../lib/physics/vehicle";
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

describe("allWheelsOffTrack", () => {
  it("is false when all four wheels are on track", () => {
    const halfWidth = track.width[200] / 2;
    const wheels = [
      pointAtLateralOffset(200, halfWidth * 0.5),
      pointAtLateralOffset(200, -halfWidth * 0.5),
      pointAtLateralOffset(200, halfWidth * 0.3),
      pointAtLateralOffset(200, -halfWidth * 0.3),
    ];
    expect(allWheelsOffTrack(track, wheels)).toBe(false);
  });

  it("is false when even one wheel still touches the track", () => {
    const halfWidth = track.width[200] / 2;
    const wheels = [
      pointAtLateralOffset(200, halfWidth + 5),
      pointAtLateralOffset(200, halfWidth + 5),
      pointAtLateralOffset(200, halfWidth + 5),
      // Fourth wheel still on track - the whole car keeps the lap legal.
      pointAtLateralOffset(200, halfWidth * 0.5),
    ];
    expect(allWheelsOffTrack(track, wheels)).toBe(false);
  });

  it("keeps a tire legal while its contact patch still overlaps the edge", () => {
    const halfWidth = track.width[200] / 2;
    const wheels = [
      pointAtLateralOffset(200, halfWidth + 0.1),
      pointAtLateralOffset(200, halfWidth + 0.1),
      pointAtLateralOffset(200, halfWidth + 0.1),
      pointAtLateralOffset(200, halfWidth + 0.1),
    ];
    expect(allWheelsOffTrack(track, wheels)).toBe(true);
    expect(allWheelsOffTrack(track, wheels, 0.34)).toBe(false);
  });

  it("is true only once all four wheels are past the edge", () => {
    const halfWidth = track.width[200] / 2;
    const wheels = [
      pointAtLateralOffset(200, halfWidth + 5),
      pointAtLateralOffset(200, halfWidth + 5),
      pointAtLateralOffset(200, halfWidth + 6),
      pointAtLateralOffset(200, halfWidth + 6),
    ];
    expect(allWheelsOffTrack(track, wheels)).toBe(true);
  });
});

describe("trackExtentMeters / worldEdgeResetMeters", () => {
  it("leaves every circuit the margin clear of the reset boundary", () => {
    for (const entry of TRACKS) {
      const circuit = getTrack(entry.id);
      const extent = trackExtentMeters(circuit);
      expect(extent).toBeGreaterThan(500);
      expect(worldEdgeResetMeters(circuit)).toBeGreaterThanOrEqual(
        extent + TRACK_EDGE_MARGIN_METERS
      );
    }
  });

  it("pushes the boundary out for a circuit bigger than the bare constant", () => {
    // Monza reaches ~1217m from the projection origin on its own, past
    // WORLD_EDGE_RESET_METERS: with the old flat constant the reset fired on
    // ordinary racing surface (the Parabolica) rather than on the horizon.
    const monza = getTrack("monza");
    const extent = trackExtentMeters(monza);
    expect(extent).toBeGreaterThan(WORLD_EDGE_RESET_METERS);
    expect(worldEdgeResetMeters(monza)).toBeCloseTo(
      extent + TRACK_EDGE_MARGIN_METERS,
      6
    );
    expect(worldEdgeResetMeters(monza)).toBeGreaterThan(WORLD_EDGE_RESET_METERS);
  });

  it("keeps a circuit that fits inside the bare constant on the constant", () => {
    const circuit = getTrack("silverstone");
    expect(trackExtentMeters(circuit) + TRACK_EDGE_MARGIN_METERS).toBeLessThan(
      WORLD_EDGE_RESET_METERS
    );
    expect(worldEdgeResetMeters(circuit)).toBe(WORLD_EDGE_RESET_METERS);
  });
});
