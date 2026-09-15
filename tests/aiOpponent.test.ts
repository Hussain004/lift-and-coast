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
  it("drives the real Silverstone trimesh for a full lap-plus (150s) without flipping or getting stuck", async () => {
    // 150s, not 90s: a real regression (smoothing the speed profile the AI
    // actually drives to, to fix an unrelated HUD color-flicker complaint)
    // shipped and passed a 90s version of this test cleanly - the flip it
    // caused (maxTiltRad 0.11 -> 1.04) only showed up between 90s and
    // 150s, on a specific corner later in the lap. This system's chaotic
    // sensitivity (see pathFollower.ts's own comment) means a short run
    // genuinely cannot stand in for a full lap - don't shorten this again.
    const track = silverstone as TrackData;
    const racingLine = computeRacingLine(track);

    const result = await simulateDrive(
      150,
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
    // (net displacement) - over 150s this run covers more than a full lap
    // of Silverstone's 5891m, so displacement alone would understate real
    // progress once the car laps back toward its own start. Validated
    // ~6828m at 150s - a low number here means the AI stalled, not
    // actually lapping.
    expect(result.distanceTraveledMeters).toBeGreaterThan(5000);
    // LOOKAHEAD_POINTS was swept 10-35 points (with gain 0.7-1.2) against
    // full-lap-plus-length runs before picking 25 (see pathFollower.ts's
    // own comment), and the speed profile's cornering cap is a real
    // lateral-grip-limited radius calculation, not an empirical penalty
    // (see racingLine.ts's MAX_LATERAL_ACCEL_MS2). This pure-pursuit
    // controller still runs a real, bounded distance wide of the racing
    // line on the track's hardest corners rather than tracking it
    // perfectly - that is a steering/lookahead precision limit, not a
    // speed or line-shape problem. Validated ~11.1m at 150s; this
    // threshold has real margin above that, not a tight fit.
    expect(result.maxOffTrackMeters).toBeLessThan(25);
  }, 30000);
});
