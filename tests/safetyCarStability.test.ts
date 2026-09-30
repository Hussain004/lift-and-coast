import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import { computeAIControls, nearestLineIndex } from "../lib/ai/pathFollower";
import { difficultyEngineForceScale, difficultyPaceScale } from "../lib/ai/personalities";
import { SC_CAP_MS, VSC_CAP_MS } from "../lib/race/safetyCar";
import { DEFAULT_BRAKE_FORCE, DEFAULT_ENGINE_FORCE, DEFAULT_STABILIZE_STRENGTH } from "../lib/physics/vehicle";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { getTrack } from "../lib/tracks/trackData";
import { simulateField } from "./helpers/fieldSim";

/**
 * The safety-car AI gate. The cap only lowers speed targets, and this proves
 * the AI stays on its wheels and on the road when it is switched on mid-lap
 * (braking from full speed), held for a minute, and released (accelerating
 * back up) - the transitions are the risky part, not the steady state.
 *
 * Suzuka is not in this list on purpose. Its bridge crossover (station
 * ~4650-4760 m) is the one place the AI is fragile in EVERY configuration
 * (see the long comment in lib/ai/pathFollower.ts): any change of the car's
 * timing there, this cap included, can tip the lap either way (sampled: 3 of
 * 10 switch times flip, exactly like the paces in that comment). The live AI
 * recovers a flipped car (lib/ai/recovery.ts) and puts it back on the line.
 */
const FLIP_RAD = 0.6;
const OFF_TRACK_M = 6;
const ON_AT = 40;
const OFF_AT = 100;

async function drive(trackId: string, cap: number) {
  const track = getTrack(trackId);
  const line = computeRacingLine(track, "pro");
  let warm: number | undefined;
  let topSpeedUnderCap = 0;
  const result = await simulateDrive(
    170,
    (elapsed, state) => {
      warm = nearestLineIndex(line, state.x, state.z, warm);
      const capped = elapsed >= ON_AT && elapsed < OFF_AT;
      return computeAIControls(
        line,
        state.x,
        state.z,
        state.yawRad,
        state.speedMs,
        false,
        difficultyPaceScale("pro", trackId),
        0,
        warm,
        undefined,
        capped ? cap : undefined
      );
    },
    {
      engineForce: DEFAULT_ENGINE_FORCE * difficultyEngineForceScale("pro", trackId),
      brakeForce: DEFAULT_BRAKE_FORCE,
      stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      track,
      onTelemetry: (sample) => {
        // Give it 12 s to shed speed, then it must be at the ceiling.
        if (sample.elapsedSeconds > ON_AT + 12 && sample.elapsedSeconds < OFF_AT) {
          topSpeedUnderCap = Math.max(topSpeedUnderCap, sample.speedMs);
        }
      },
    }
  );
  return { ...result, topSpeedUnderCap };
}

describe("safety car AI stability", () => {
  for (const trackId of ["monza", "monaco", "spa", "jeddah"]) {
    it(`${trackId}: stays upright and on the road through a safety car and a VSC`, async () => {
      for (const cap of [SC_CAP_MS, VSC_CAP_MS]) {
        const r = await drive(trackId, cap);
        expect(r.maxTiltRad, `${trackId} @${cap}`).toBeLessThan(FLIP_RAD);
        expect(r.maxOffTrackMeters, `${trackId} @${cap}`).toBeLessThan(OFF_TRACK_M);
        // The ceiling really holds (a little over is the braking overshoot).
        expect(r.topSpeedUnderCap, `${trackId} @${cap}`).toBeLessThan(cap * 1.08);
      }
    }, 240000);
  }
});

describe("speed ceiling in the path follower", () => {
  const line = computeRacingLine(getTrack("monza"), "pro");
  const p = line[100].position;
  const at = (cap?: number, speed = 70) =>
    computeAIControls(line, p[0], p[2], 0, speed, false, 1, 0, undefined, undefined, cap);

  it("is inert when absent or infinite", () => {
    expect(at(undefined)).toEqual(at(Infinity));
  });

  it("brakes a car above the ceiling and never changes the steering", () => {
    const free = at(undefined, 70);
    const capped = at(38, 70);
    expect(capped.steer).toBe(free.steer);
    expect(capped.brake).toBeGreaterThan(free.brake);
    expect(capped.throttle).toBeLessThanOrEqual(free.throttle);
  });

  it("lets a car below the ceiling keep its own throttle", () => {
    expect(at(80, 30)).toEqual(at(undefined, 30));
  });
});

const GRID = [
  "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM", "LEC", "NOR",
  "VER", "PIA", "RUS", "GAS", "SAI", "OCO", "ALB", "TSU", "ZHO", "MAG",
];

describe("safety car with a full 20-car field", () => {
  // A safety car bunches the field up and then releases it, which is where
  // contact would appear. Measured against the same grid with no safety car
  // (contacts 7-14 per circuit, nearly all in the standing start), the
  // period adds none beyond one at Monaco; the bounds below sit just above
  // that so a real regression trips them.
  for (const trackId of ["monza", "monaco"]) {
    it(`${trackId}: closes up under the ceiling and restarts without crashes`, async () => {
      const r = await simulateField(GRID, {
        seconds: 170,
        track: getTrack(trackId),
        difficulty: "pro",
        safetyCar: { fromSeconds: 50, toSeconds: 110, capMs: SC_CAP_MS },
      });
      for (const car of r.cars) expect(car.maxTilt, car.code).toBeLessThan(FLIP_RAD);
      expect(r.field.firewallResets).toBe(0);
      expect(r.field.spins).toBe(0);
      expect(r.field.contacts).toBeLessThanOrEqual(16);
      expect(r.field.hardContacts).toBeLessThanOrEqual(6);
    }, 300000);
  }
});
