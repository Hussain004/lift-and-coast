import {
  difficultyPaceScale,
  hashDriverCode,
  traitsForDriver,
  type AIDifficulty,
} from "../ai/personalities";
import { getRacingLine } from "../tracks/racingLineCache";
import { type RacingLineProfile } from "../tracks/racingLine";
import { analyzeRacingLine } from "../tracks/racingLineQuality";
import type { TrackData } from "../tracks/types";
import type { QualifyingTimes } from "./qualifying";

/**
 * The generated line is a target envelope, not a measured lap. A small
 * execution allowance keeps the hidden qualifying field in the same physical
 * neighborhood as a real standing-start lap without pretending that the
 * browser has run a second physics world for every rival.
 */
const REFERENCE_EXECUTION_FACTOR = 1.045;

/** A gentle tier spread on top of the selected line/pace package. */
const DIFFICULTY_REFERENCE_FACTOR: Record<AIDifficulty, number> = {
  rookie: 1.04,
  club: 1.015,
  pro: 1,
  ace: 0.992,
};

/** Only a fraction of the target-speed pace scale is visible in lap time. */
const PACE_REFERENCE_WEIGHT = 0.12;

/** Individual reference laps should be close, but not identical. */
const DRIVER_REFERENCE_SPREAD = 0.025;

function profileForDifficulty(difficulty: AIDifficulty): RacingLineProfile {
  if (difficulty === "ace") return "ace";
  if (difficulty === "pro") return "pro";
  return "default";
}

function deterministicDriverOffset(code: string): number {
  const bucket = (hashDriverCode(code) >>> 8) % 1000;
  return (bucket / 999 - 0.5) * 2;
}

/**
 * Builds the AI reference field for a player-only qualifying session.
 *
 * The rivals remain in the roster and the resulting qualifying order is still
 * carried into the race handoff, but no AICar is mounted for this mode. The
 * reference times are deterministic, track-aware, and driver-aware: they are
 * generated from the selected racing line, tier pace, and the same stable
 * driver personality used by the live AI. This is intentionally a lightweight
 * timing model rather than a second Rapier simulation on the main thread.
 */
export function createQualifyingReferenceTimes(
  track: TrackData,
  rivals: readonly { code: string }[],
  difficulty: AIDifficulty
): QualifyingTimes {
  const profile = profileForDifficulty(difficulty);
  const quality = analyzeRacingLine(track, getRacingLine(track, profile));
  const theoreticalLapSeconds = Math.max(1, quality.theoreticalLapSeconds);
  const pace = difficultyPaceScale(difficulty, track.id);
  // The line's physical caps dominate the final time, so a tier pace change
  // is represented conservatively instead of dividing the whole lap by it.
  const paceFactor = 1 / (1 + (pace - 1) * PACE_REFERENCE_WEIGHT);
  const difficultyFactor = DIFFICULTY_REFERENCE_FACTOR[difficulty];
  const baseLapSeconds = theoreticalLapSeconds * REFERENCE_EXECUTION_FACTOR * paceFactor * difficultyFactor;

  return {
    player: null,
    opponents: rivals.map(({ code }) => {
      const traits = traitsForDriver(code);
      const driverOffset = deterministicDriverOffset(code);
      const driverPaceFactor = 1 / traits.pace;
      const time = baseLapSeconds * driverPaceFactor * (1 + driverOffset * DRIVER_REFERENCE_SPREAD);
      return Number.isFinite(time) && time > 0 ? time : baseLapSeconds;
    }),
  };
}
