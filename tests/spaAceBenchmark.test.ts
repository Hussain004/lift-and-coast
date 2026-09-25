import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import { computeAIControls, nearestLineIndex } from "../lib/ai/pathFollower";
import { difficultyEngineForceScale } from "../lib/ai/personalities";
import { DEPLOY_BOOST_MULTIPLIER } from "../lib/physics/energy";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import { getTrack } from "../lib/tracks/trackData";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { analyzeRacingLine } from "../lib/tracks/racingLineQuality";

/** The player's measured standing-start Spa lap is 2:08. */
const PLAYER_STANDING_START_SECONDS = 128;
/** The acceptance run stays well inside the project-wide 6m runaway gate. */
const MAX_OFF_TRACK_METERS = 3;
const ACE_STRAIGHT_AERO_THRESHOLD_MS = 65;
const ACE_STRAIGHT_AERO_PREVIEW_METERS = 300;

describe("Pro Spa standing-start benchmark", () => {
  it("beats the player from a standing start without a track-limit excursion", async () => {
    const track = getTrack("spa");
    const line = computeRacingLine(track, "pro");
    const quality = analyzeRacingLine(track, line);
    let previousProgress = 0;
    let lapStart = 0;
    let lapSeconds: number | null = null;
    let firstLapComplete = false;
    let firstLapMaxOffMeters = 0;

    const result = await simulateDrive(
      180,
      (_time, state) => {
        const controls = computeAIControls(
          line,
          state.x,
          state.z,
          state.yawRad,
          state.speedMs,
          false,
          1.18
        );
        const nearest = nearestLineIndex(line, state.x, state.z);
        let previewMeters = 0;
        let straight = true;
        for (let i = 0; i < line.length && previewMeters < ACE_STRAIGHT_AERO_PREVIEW_METERS; i++) {
          const point = line[(nearest + i) % line.length];
          if (point.targetSpeedMs < ACE_STRAIGHT_AERO_THRESHOLD_MS) {
            straight = false;
            break;
          }
          previewMeters += point.distanceToNextMeters;
        }
        return {
          ...controls,
          // A solo Pro qualifying run has the full straight-line deployment
          // envelope available. Traffic racing still uses the shared energy
          // and racecraft gates in AICar.tsx.
          boostMultiplier: DEPLOY_BOOST_MULTIPLIER,
          aeroMode: straight ? "low-drag" : "high-downforce",
        };
      },
      {
        engineForce:
          DEFAULT_ENGINE_FORCE * difficultyEngineForceScale("pro", track.id),
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        track,
        onTelemetry: (sample) => {
          const status = checkTrackLimits(
            track,
            sample.position.x,
            sample.position.z,
            sample.position.y
          );
          if (!firstLapComplete) {
            firstLapMaxOffMeters = Math.max(
              firstLapMaxOffMeters,
              status.distanceFromEdgeMeters
            );
          }
          if (
            !firstLapComplete &&
            previousProgress > track.lengthMeters * 0.75 &&
            status.progressMeters < track.lengthMeters * 0.25
          ) {
            lapSeconds = sample.elapsedSeconds - lapStart;
            lapStart = sample.elapsedSeconds;
            firstLapComplete = true;
          }
          previousProgress = status.progressMeters;
        },
      }
    );

    expect(quality.theoreticalLapSeconds).toBeLessThan(PLAYER_STANDING_START_SECONDS);
    expect(lapSeconds).not.toBeNull();
    expect(lapSeconds!).toBeLessThan(127.5);
    expect(firstLapMaxOffMeters).toBeLessThan(MAX_OFF_TRACK_METERS);
    expect(result.maxTiltRad).toBeLessThan(0.6);
  }, 300000);
});
