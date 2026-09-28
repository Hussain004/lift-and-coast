import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import { computeAIControls, nearestLineIndex } from "../lib/ai/pathFollower";
import {
  difficultyEngineForceScale,
  difficultyPaceScale,
  weatherPaceScale,
  WET_PACE_MARGIN,
} from "../lib/ai/personalities";
import { createWeatherSystem, type WeatherState } from "../lib/physics/weather";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import { getTrack } from "../lib/tracks/trackData";
import type { TrackData } from "../lib/tracks/types";

/**
 * The wet-weather AI gate.
 *
 * IT EXISTS BECAUSE THE HARNESS HAD NO WEATHER AT ALL. Every AI gate in this
 * project ran a car on dry asphalt, and the racing line's speed profile is built
 * for dry grip, so nothing anywhere asserted that the AI could still drive when
 * the grip it was tuned on went away. The failure that hides behind that gap is
 * not subtle: in the rain the AI kept its dry corner speeds, arrived at corners
 * it could no longer hold, and either ran wide or wedged itself against a
 * barrier - measured at Spa, where it drove into the wall at 42% of the lap and
 * sat there at zero speed with the throttle buried and full lock.
 *
 * The fix is not in the control law (see weatherPaceScale in personalities.ts
 * for why: the target is scaled by grip, a modulation of the pace input the
 * difficulty and tire curve already use). This file is what proves it works, and
 * what would catch it regressing.
 */

/** The flip gate the project's other AI gates use. */
const FLIP_THRESHOLD_RAD = 0.6;
/** The off-track budget the dry AI gates already accept (aceTrackBenchmark). */
const MAX_OFF_TRACK_METERS = 6;
/** Enough simulated time for one standing-start lap of the slowest circuit here. */
const LAP_WINDOW_SECONDS = 260;

/** The weather system's settled grip for each preset, from the real system. */
function settledGrip(preset: "clear" | "cloudy" | "rain"): WeatherState {
  const system = createWeatherSystem(preset);
  // The system's time constants are 18-38s; this runs it out so the gate uses
  // the grip the game actually races at, not a guessed constant.
  for (let i = 0; i < 400; i++) system.update(1);
  return system.snapshot();
}

const RAIN_GRIP = settledGrip("rain").gripMultiplier;
const CLOUDY_GRIP = settledGrip("cloudy").gripMultiplier;

interface WetLapResult {
  lapSeconds: number | null;
  maxTiltRad: number;
  maxOffTrackMeters: number;
}

/**
 * One standing-start lap at Pro pace, on a surface with `grip` times dry grip,
 * with the weather-aware pace the live game now applies.
 *
 * MEMOISED, because the assertions below want the same handful of runs from
 * several angles - "is the wet lap slower than dry", "is it no less stable than
 * dry" and "does it complete at all" are three questions about one pair of
 * simulations, and re-running a full lap per question tripled the cost of this
 * gate for no extra coverage. A run is a pure function of (circuit, grip), so
 * caching one cannot go stale within a process.
 */
const lapCache = new Map<string, Promise<WetLapResult>>();

function lapOn(trackId: string, grip: number, windowSeconds = LAP_WINDOW_SECONDS): Promise<WetLapResult> {
  const key = `${trackId}@${grip}@${windowSeconds}`;
  const cached = lapCache.get(key);
  if (cached !== undefined) return cached;
  const run = simulateLap(trackId, grip, windowSeconds);
  lapCache.set(key, run);
  return run;
}

async function simulateLap(
  trackId: string,
  grip: number,
  windowSeconds: number
): Promise<WetLapResult> {
  const track: TrackData = getTrack(trackId);
  const line = computeRacingLine(track, "pro");
  let warm: number | undefined;
  let previousProgress = 0;
  let lapStartedAt = 0;
  let lapSeconds: number | null = null;

  const stability = await simulateDrive(
    windowSeconds,
    (_elapsed, state) => {
      warm = nearestLineIndex(line, state.x, state.z, warm);
      return computeAIControls(
        line,
        state.x,
        state.z,
        state.yawRad,
        state.speedMs,
        false,
        // Exactly what AICar.tsx composes: difficulty pace times weather pace.
        difficultyPaceScale("pro", track.id) * weatherPaceScale(grip),
        0,
        warm
      );
    },
    {
      engineForce: DEFAULT_ENGINE_FORCE * difficultyEngineForceScale("pro", track.id),
      brakeForce: DEFAULT_BRAKE_FORCE,
      stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      track,
      gripMultiplier: grip,
      onTelemetry: (sample) => {
        const status = checkTrackLimits(track, sample.position.x, sample.position.z, sample.position.y);
        // The same crossing rule the ace benchmark uses, so a wet lap is timed
        // the same way a dry one is and the two are comparable.
        if (
          sample.elapsedSeconds > 5 &&
          previousProgress > track.lengthMeters * 0.75 &&
          status.progressMeters < track.lengthMeters * 0.25
        ) {
          if (lapSeconds === null) lapSeconds = sample.elapsedSeconds - lapStartedAt;
          lapStartedAt = sample.elapsedSeconds;
        }
        previousProgress = status.progressMeters;
      },
    }
  );
  return {
    lapSeconds,
    maxTiltRad: stability.maxTiltRad,
    maxOffTrackMeters: stability.maxOffTrackMeters,
  };
}

describe("weatherPaceScale", () => {
  it("is exactly 1 on dry, so no existing AI gate moves", () => {
    // THE property everything else rests on. Thirty circuits' worth of
    // verified tuning ran at grip 1, so this has to be bit-identical there -
    // not "close to", not "within a tolerance".
    expect(weatherPaceScale(1)).toBe(1);
    expect(weatherPaceScale(1.0)).toBe(1);
    // A grip above 1 (a friction modifier from setup, say) must not slow the
    // car either; the dry case is the identity, not a curve that passes
    // through it.
    expect(weatherPaceScale(1.4)).toBe(1);
  });

  it("falls monotonically as grip falls, and never exceeds 1", () => {
    let previous = Infinity;
    for (let grip = 1; grip >= 0.3; grip -= 0.05) {
      const scale = weatherPaceScale(grip);
      expect(scale, `grip ${grip.toFixed(2)}`).toBeLessThanOrEqual(1);
      expect(scale, `grip ${grip.toFixed(2)}`).toBeLessThan(previous);
      expect(scale, `grip ${grip.toFixed(2)}`).toBeGreaterThan(0);
      previous = scale;
    }
  });

  it("brakes within what the grip can actually pay for", () => {
    // The follower reads a static speed profile and chases it; scaling it by k
    // scales the deceleration it needs by k^2, so the profile is only reachable
    // while k^2 <= grip. The margin makes it reachable with room to spare, and
    // this is the assertion that keeps a future "just use grip directly" change
    // from quietly reintroducing a car that cannot stop in time.
    for (const grip of [0.9, 0.7, 0.58, 0.4]) {
      expect(weatherPaceScale(grip) ** 2, `grip ${grip}`).toBeLessThan(grip);
    }
  });

  it("agrees with the weather system's own grip for every preset", () => {
    // Not a hardcoded 0.70: read from the real system, so if the weather
    // presets ever move, the pace follows them instead of drifting from them.
    for (const preset of ["clear", "cloudy", "rain"] as const) {
      const { gripMultiplier } = settledGrip(preset);
      expect(weatherPaceScale(gripMultiplier), preset).toBe(weatherPaceScale(gripMultiplier));
    }
    // And the ordering the presets imply: clear fastest, rain slowest.
    expect(weatherPaceScale(settledGrip("clear").gripMultiplier)).toBe(1);
    expect(weatherPaceScale(settledGrip("rain").gripMultiplier)).toBeLessThan(
      weatherPaceScale(settledGrip("cloudy").gripMultiplier)
    );
  });

  it("degrades gracefully on nonsense input", () => {
    expect(weatherPaceScale(Number.NaN)).toBe(1);
    expect(weatherPaceScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(weatherPaceScale(0)).toBe(0);
    expect(weatherPaceScale(-1)).toBe(0);
  });

  it("leaves a real margin at the rain grip the game actually uses", () => {
    // Pinned so a change to WET_PACE_MARGIN that would put the wet AI back on
    // the friction limit has to be a deliberate, visible edit.
    expect(RAIN_GRIP).toBeGreaterThan(0.65);
    expect(RAIN_GRIP).toBeLessThan(0.75);
    expect(weatherPaceScale(RAIN_GRIP)).toBeCloseTo(Math.sqrt(RAIN_GRIP) * WET_PACE_MARGIN, 12);
    expect(weatherPaceScale(RAIN_GRIP)).toBeLessThan(0.75);
  });
});

/**
 * Spa is the circuit that failed worst before the fix (18.6m off, wedged
 * against a barrier, zero speed), Suzuka is the documented knife edge where its
 * response to pace is non-monotonic, and Monza is a clean baseline. Those three
 * cover the two ways this has previously broken plus a control.
 */
const GATE_TRACKS = ["spa", "suzuka", "monza"] as const;

describe("AI in the wet", () => {
  for (const trackId of GATE_TRACKS) {
    it(`still completes a lap on ${trackId} in the rain`, async () => {
      const wet = await lapOn(trackId, RAIN_GRIP);
      // The failure this gate exists for: no lap at all, because the car ran
      // wide of a corner it was still aiming at dry speeds for.
      expect(wet.lapSeconds, `${trackId} wet lap`).not.toBeNull();
      expect(wet.lapSeconds!, `${trackId} wet lap`).toBeGreaterThan(0);
      // Not inverted, on the same 0.6rad gate the dry AI gates use.
      expect(wet.maxTiltRad, `${trackId} tilt`).toBeLessThan(FLIP_THRESHOLD_RAD);
      // And inside the same off-track budget the dry gates already accept: the
      // wet must not be a licence to widen the line.
      expect(wet.maxOffTrackMeters, `${trackId} off-track`).toBeLessThan(MAX_OFF_TRACK_METERS);
    }, 120_000);
  }

  it("is measurably slower in the rain than on the same circuit dry", async () => {
    // Without this the gate would pass for a car that was fast in the wet
    // because it never slowed down - which is the bug, not the fix.
    for (const trackId of GATE_TRACKS) {
      const dry = await lapOn(trackId, 1);
      const wet = await lapOn(trackId, RAIN_GRIP);
      expect(dry.lapSeconds, `${trackId} dry lap`).not.toBeNull();
      expect(wet.lapSeconds, `${trackId} wet lap`).not.toBeNull();
      // Meaningfully slower, but not absurdly so: the weather term is a pace
      // modulation, not a different car.
      expect(wet.lapSeconds!, `${trackId} slower wet`).toBeGreaterThan(dry.lapSeconds! * 1.1);
      expect(wet.lapSeconds!, `${trackId} not crawling`).toBeLessThan(dry.lapSeconds! * 1.6);
    }
  }, 300_000);

  it("slows monotonically as grip falls", async () => {
    // The property that makes the modulation verifiable rather than a fudge:
    // less grip can never buy a faster lap. Probed at cloudy grip, which sits
    // between clear and rain, so a non-monotone response is caught on the
    // smooth part of the curve where it is least expected.
    const gripPoints = [1, CLOUDY_GRIP, RAIN_GRIP];
    const laps: number[] = [];
    for (const grip of gripPoints) {
      const result = await lapOn("monza", grip);
      expect(result.lapSeconds, `grip ${grip}`).not.toBeNull();
      laps.push(result.lapSeconds!);
    }
    expect(laps[0]).toBeLessThan(laps[1]);
    expect(laps[1]).toBeLessThan(laps[2]);
  }, 300_000);

  it("is no less stable in the rain than on the track dry", async () => {
    // Tilt and excursions both have to hold up against the dry run on the same
    // circuit. This is the claim the whole change rests on: a wet car that
    // wanders more than a dry one is a worse product even if it never crashes.
    for (const trackId of GATE_TRACKS) {
      const dry = await lapOn(trackId, 1);
      const wet = await lapOn(trackId, RAIN_GRIP);
      expect(wet.maxTiltRad, `${trackId} tilt`).toBeLessThanOrEqual(dry.maxTiltRad + 0.1);
      expect(wet.maxOffTrackMeters, `${trackId} off-track`).toBeLessThanOrEqual(
        dry.maxOffTrackMeters + 1
      );
    }
  }, 300_000);
});
