import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import { computeAIControls } from "../lib/ai/pathFollower";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";

/**
 * Plan section 15: "AI hot-lap harness (section 6): automated laps per
 * track ... run in CI on track-data changes". The pure-pursuit controller
 * and its racing line are both derived from track data at runtime, so a
 * new/changed circuit needs its own proof that the AI can complete it
 * without flipping - the Silverstone-tuned constants in pathFollower.ts are
 * shared, but the geometry they are applied to is not.
 *
 * 180s covers more than one full lap of every registered circuit (Spa, the
 * longest at ~7.0km, is the worst case at ~1.2 laps), honoring the
 * project's "never verify the AI with less than a full lap" rule. This is a
 * coarse completed-a-lap-safe gate; the fine-grained
 * chaotic-sensitivity/perturbation guard for the Silverstone-tuned
 * constants stays in tests/aiTelemetry.test.ts behind AI_TELEMETRY=1.
 */
const FLIP_THRESHOLD_RAD = 0.6;
const SECONDS = 180;
// ~33 m/s average floor - a stuck, spun or stopped car fails this by a wide
// margin, while normal pace (observed 43-48 m/s average) clears it easily.
const MIN_DISTANCE_TRAVELED_METERS = 6000;
// Observed worst single off-track excursion is ~11m on the shipped
// Silverstone baseline itself; this only catches a genuine runaway.
const MAX_OFF_TRACK_METERS = 30;

describe("per-track AI stability", () => {
  for (const { id, name } of TRACKS) {
    it(
      `AI hot-laps ${name} (${id}) for ${SECONDS}s without flipping`,
      async () => {
        const track = getTrack(id);
        const line = computeRacingLine(track);
        const result = await simulateDrive(
          SECONDS,
          (_elapsedSeconds, state) =>
            computeAIControls(
              line,
              state.x,
              state.z,
              state.yawRad,
              state.speedMs
            ),
          {
            engineForce: DEFAULT_ENGINE_FORCE,
            brakeForce: DEFAULT_BRAKE_FORCE,
            stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
            track,
          }
        );

        expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
        expect(result.distanceTraveledMeters).toBeGreaterThan(
          MIN_DISTANCE_TRAVELED_METERS
        );
        expect(result.maxOffTrackMeters).toBeLessThan(MAX_OFF_TRACK_METERS);
      },
      30000
    );
  }
});