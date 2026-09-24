import { simulateDrive, type StabilityResult } from "../../lib/ai/harness";
import { computeAIControls, nearestLineIndex } from "../../lib/ai/pathFollower";
import {
  difficultyEngineForceScale,
  difficultyPaceScale,
  type AIDifficulty,
} from "../../lib/ai/personalities";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../../lib/physics/vehicle";
import { computeRacingLine, type RacingLineProfile } from "../../lib/tracks/racingLine";
import { analyzeRacingLine, type RacingLineQuality } from "../../lib/tracks/racingLineQuality";
import { checkTrackLimits } from "../../lib/tracks/trackLimits";
import type { TrackData } from "../../lib/tracks/types";

export interface AceLapBenchmark {
  profile: RacingLineProfile;
  theoreticalLapSeconds: number;
  measuredLapSeconds: number | null;
  distanceTraveledMeters: number;
  maxOffTrackMeters: number;
  firstLapMaxOffTrackMeters: number;
  maxTiltRad: number;
  quality: RacingLineQuality;
  stability: StabilityResult;
}

/**
 * Run one standing-start lap with the production line follower and vehicle.
 * The all-track gate deliberately uses the race-safe high-downforce/no-boost
 * plan: energy deployment and active aero are already governed by racecraft in
 * a live field, while Spa's separate qualifying benchmark covers the more
 * aggressive solo deployment envelope.
 */
export async function runStandingStartLap(
  track: TrackData,
  profile: RacingLineProfile
): Promise<AceLapBenchmark> {
  const line = computeRacingLine(track, profile);
  const quality = analyzeRacingLine(track, line);
  const benchmarkDifficulty: AIDifficulty = profile === "default" ? "pro" : profile;
  // Slow circuits need more than the old fixed 180s window. This remains a
  // one-lap benchmark, with a generous bounded margin rather than an
  // endurance test.
  const seconds = Math.min(360, Math.max(150, Math.ceil(quality.theoreticalLapSeconds * 1.2 + 20)));
  let previousProgress = 0;
  let lapStartedAt = 0;
  let measuredLapSeconds: number | null = null;
  let firstLapComplete = false;
  let firstLapMaxOffTrackMeters = 0;
  let warmStartIndex: number | undefined;

  const stability = await simulateDrive(
    seconds,
    (_elapsedSeconds, state) => {
      warmStartIndex = nearestLineIndex(line, state.x, state.z, warmStartIndex);
      return computeAIControls(
        line,
        state.x,
        state.z,
        state.yawRad,
        state.speedMs,
        false,
        difficultyPaceScale(benchmarkDifficulty, track.id),
        0,
        warmStartIndex
      );
    },
    {
      engineForce:
        DEFAULT_ENGINE_FORCE *
        (benchmarkDifficulty === "pro" ? 1 : difficultyEngineForceScale(benchmarkDifficulty, track.id)),
      brakeForce: DEFAULT_BRAKE_FORCE,
      stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      track,
      onTelemetry: (sample) => {
        const status = checkTrackLimits(track, sample.position.x, sample.position.z, sample.position.y);
        if (!firstLapComplete) {
          firstLapMaxOffTrackMeters = Math.max(
            firstLapMaxOffTrackMeters,
            status.distanceFromEdgeMeters
          );
        }
        if (
          !firstLapComplete &&
          sample.elapsedSeconds > 5 &&
          previousProgress > track.lengthMeters * 0.75 &&
          status.progressMeters < track.lengthMeters * 0.25
        ) {
          measuredLapSeconds = sample.elapsedSeconds - lapStartedAt;
          lapStartedAt = sample.elapsedSeconds;
          firstLapComplete = true;
        }
        previousProgress = status.progressMeters;
      },
    }
  );

  return {
    profile,
    theoreticalLapSeconds: quality.theoreticalLapSeconds,
    measuredLapSeconds,
    distanceTraveledMeters: stability.distanceTraveledMeters,
    maxOffTrackMeters: stability.maxOffTrackMeters,
    firstLapMaxOffTrackMeters,
    maxTiltRad: stability.maxTiltRad,
    quality,
    stability,
  };
}
