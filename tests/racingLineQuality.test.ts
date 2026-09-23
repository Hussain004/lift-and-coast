import { describe, expect, it } from "vitest";
import { getRacingLine } from "../lib/tracks/racingLineCache";
import { getTrack } from "../lib/tracks/trackData";
import { TRACKS } from "../lib/tracks/registry";
import { analyzeRacingLine, RACING_LINE_ACCELERATION_LIMIT, RACING_LINE_DECELERATION_LIMIT } from "../lib/tracks/racingLineQuality";
import { simulateDrive } from "../lib/ai/harness";
import { computeAIControls } from "../lib/ai/pathFollower";
import { DEFAULT_BRAKE_FORCE, DEFAULT_ENGINE_FORCE, DEFAULT_STABILIZE_STRENGTH } from "../lib/physics/vehicle";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import type { TrackData } from "../lib/tracks/types";

describe("racing-line quality gates", () => {
  it("keeps every real circuit finite, on-road, and physically feasible", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const quality = analyzeRacingLine(track, getRacingLine(track));
      expect(Number.isFinite(quality.lengthMeters), meta.id).toBe(true);
      expect(Number.isFinite(quality.theoreticalLapSeconds), meta.id).toBe(true);
      expect(quality.minimumEdgeMarginMeters, meta.id).toBeGreaterThan(0.25);
      // A tight real hairpin can legitimately approach 1 rad/m at the
      // centerline sample spacing. The gate catches the old folded-line
      // spikes above that range without rejecting a real slow corner.
      expect(quality.maximumCurvature, meta.id).toBeLessThan(1);
      expect(quality.maximumRequiredDeceleration, meta.id).toBeLessThanOrEqual(
        RACING_LINE_DECELERATION_LIMIT + 0.05
      );
      expect(quality.maximumRequiredAcceleration, meta.id).toBeLessThanOrEqual(
        RACING_LINE_ACCELERATION_LIMIT + 0.05
      );
      expect(quality.shortestZoneRunPoints, meta.id).toBeGreaterThan(0);
    }
  });
});

const runBenchmark = process.env.LINE_BENCHMARK === "1" ? it : it.skip;
runBenchmark("benchmarks solo AI laps before racecraft is enabled", async () => {
  for (const meta of TRACKS) {
    const track = getTrack(meta.id) as TrackData;
    const line = getRacingLine(track);
    const quality = analyzeRacingLine(track, line);
    let previousProgress = 0;
    let lapStartedAt = 0;
    let completedLaps = 0;
    let bestLapSeconds = Infinity;
    // One full lap plus a controlled margin. Do not turn this into an
    // endurance test: the AI benchmark's job is to validate the line and
    // solo control law, while repeated-lap tire/racecraft behavior belongs
    // in the field tests. The old 1.6x window let a second Suzuka lap turn
    // a passing one-lap result into a misleading bridge-tilt failure.
    const benchmarkSeconds = Math.min(300, Math.max(150, quality.theoreticalLapSeconds * 1.2 + 20));
    const result = await simulateDrive(
      benchmarkSeconds,
      (_time, state) => computeAIControls(line, state.x, state.z, state.yawRad, state.speedMs, false, 1.18),
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        track,
        onTelemetry: (sample) => {
          const progress = checkTrackLimits(track, sample.position.x, sample.position.z, sample.position.y).progressMeters;
          if (previousProgress > track.lengthMeters * 0.75 && progress < track.lengthMeters * 0.25) {
            const lapSeconds = sample.elapsedSeconds - lapStartedAt;
            if (lapSeconds > 10) {
              completedLaps++;
              bestLapSeconds = Math.min(bestLapSeconds, lapSeconds);
              lapStartedAt = sample.elapsedSeconds;
            }
          }
          previousProgress = progress;
        },
      }
    );
    console.log(
      `[line-benchmark] ${meta.id.padEnd(12)} target=${quality.theoreticalLapSeconds.toFixed(2)}s best=${bestLapSeconds === Infinity ? "n/a" : bestLapSeconds.toFixed(2)}s laps=${completedLaps} off=${result.maxOffTrackMeters.toFixed(2)}m tilt=${result.maxTiltRad.toFixed(3)}`
    );
    expect(completedLaps, meta.id).toBeGreaterThanOrEqual(1);
    expect(bestLapSeconds, meta.id).toBeLessThan(quality.theoreticalLapSeconds * 2.2);
    expect(result.maxTiltRad, meta.id).toBeLessThan(0.6);
    expect(result.maxOffTrackMeters, meta.id).toBeLessThan(6);
  }
}, 900000);
