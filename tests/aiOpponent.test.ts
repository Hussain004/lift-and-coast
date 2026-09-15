import { describe, expect, it } from "vitest";
import { simulateDrive, type DriveState } from "../lib/ai/harness";
import { DEFAULT_BRAKE_FORCE, DEFAULT_ENGINE_FORCE, DEFAULT_STABILIZE_STRENGTH } from "../lib/physics/vehicle";
import { computeAIControls } from "../lib/ai/pathFollower";
import { computeRacingLine } from "../lib/tracks/racingLine";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

// Same convention as vehicle-stability.test.ts/aeroGrip.test.ts/etc.
const FLIP_THRESHOLD_RAD = 0.6;

describe("AI opponent hot lap (plan section 6's non-negotiable test harness)", () => {
  it("drives the real Silverstone trimesh for 60s on the racing line without flipping or getting stuck", async () => {
    const track = silverstone as TrackData;
    const racingLine = computeRacingLine(track);

    const result = await simulateDrive(
      60,
      (_elapsedSeconds: number, state: DriveState) =>
        computeAIControls(racingLine, state.x, state.z, state.yawRad, state.speedMs),
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        track,
      }
    );

    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
    // distanceTraveledMeters (real path length driven), not distanceMeters
    // (net displacement) - over 60s this run covers a large enough chunk
    // of Silverstone's 5891m lap that displacement alone would understate
    // real progress once the car laps back toward its own start. At this
    // track's average curvature-derived target pace (tuned and checked in
    // pathFollower.ts's own comments), 60s of real driving should cover
    // well over a third of a lap - a low number here means the AI stalled,
    // not actually lapping.
    expect(result.distanceTraveledMeters).toBeGreaterThan(1500);
    // Following its own racing line, the AI shouldn't need to run wide
    // into the grass by more than a few meters at any point.
    expect(result.maxOffTrackMeters).toBeLessThan(15);
  }, 20000);
});
