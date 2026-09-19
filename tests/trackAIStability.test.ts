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
// Distance floor: a stuck, spun or stopped car fails this by a wide margin,
// while normal pace clears it easily. Per-track, because pace is set by the
// downforce-aware speed profile (see racingLine.ts): Monaco's 3333m lap is
// mostly slow corners where the honest target averages ~30 m/s, so no
// controller can average the 33 m/s a single global floor demands there -
// the floor below still requires MORE than one full Monaco lap (3500 >
// 3333, observed ~4200) while the flowing circuits keep the ~33 m/s bar
// (observed 6300-7400). Same logic for the scale-out circuits, measured
// with the same harness: Spielberg is short and fast (5000 over a 4311m
// lap), Bahrain's traction zones pace it at ~33 m/s (5300 over 5431m),
// COTA has the slowest profile of the set at ~38 m/s target average (4000
// still separates a stalled car several times over), Zandvoort's dunes at
// ~40 (4500 over 4268m). Second scale-out batch, same method: Budapest
// 4500, Melbourne 5000, Montreal 4500, Mexico 4500, Shanghai 5000,
// Interlagos 5000 (1.16 laps, observed 6202), Yas Marina 4500 (observed
// 5791). Third batch, same method: Hockenheim 5000 (1.1 laps, observed
// 5620), Sepang, Sochi and the Nürburgring 4500 each (observed
// 5649/5642/5407).
const MIN_DISTANCE_TRAVELED_METERS: Record<string, number> = {
  silverstone: 6000,
  monza: 6000,
  spa: 6000,
  suzuka: 6000,
  monaco: 3500,
  spielberg: 5000,
  bahrain: 5300,
  cota: 4000,
  zandvoort: 4500,
  budapest: 4500,
  melbourne: 5000,
  montreal: 4500,
  mexico: 4500,
  shanghai: 5000,
  interlagos: 5000,
  yasmarina: 4500,
  hockenheim: 5000,
  sepang: 4500,
  sochi: 4500,
  nurburgring: 4500,
};
// Observed worst single off-track excursion is ~6m (down from ~23m before
// the downforce-aware profile); this only catches a genuine runaway.
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
          MIN_DISTANCE_TRAVELED_METERS[id]
        );
        expect(result.maxOffTrackMeters).toBeLessThan(MAX_OFF_TRACK_METERS);
      },
      30000
    );
  }
});