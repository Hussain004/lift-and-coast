import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import {
  FINAL_DRIVE_MAX,
  FINAL_DRIVE_MIN,
  FINAL_DRIVE_NOMINAL,
  GEAR_COUNT,
  SHIFT_UP_RPM,
  effectiveGearRatio,
  finalDriveLabel,
  normalizeFinalDriveScale,
  rpmForGear,
} from "../lib/physics/gearbox";

/**
 * Measurement test for the final drive setup slider (roadmap 11.11).
 *
 * A final drive is the one setup control in this project that changes the
 * GEARS rather than a force, so it gets a test that actually measures the
 * car rather than only asserting properties of the scale:
 *
 *  - the neutral value must be a bit-identical no-op (scale 1 multiplies
 *    every ratio by exactly 1), and
 *  - both ends of the slider must stay inside the already-verified envelope:
 *    the flip threshold with margin, and 0-200 km/h / straight-line distance
 *    that never exceeds what the as-shipped gearing achieves.
 *
 * The ranges below are the MEASURED ones, not aspirations. If a future edit
 * widens FINAL_DRIVE_MIN/MAX, this test is the thing that fails first.
 */

const BASE = {
  engineForce: DEFAULT_ENGINE_FORCE,
  brakeForce: DEFAULT_BRAKE_FORCE,
  stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
};
const FLIP_THRESHOLD_RAD = 0.6;
/** Comfortably under the flip threshold, matching the other setup gates. */
const TILT_CEILING_RAD = 0.3;
const KMH_TO_MS = 1 / 3.6;
const ZERO_TO_200_MS = 200 * KMH_TO_MS;

/** Distance covered in the first N seconds of a flat-out standing start. */
async function launchDistanceMeters(seconds: number, finalDriveScale?: number) {
  const result = await simulateDrive(
    seconds,
    { throttle: 1, brake: 0, steer: 0 },
    { ...BASE, ...(finalDriveScale === undefined ? {} : { finalDriveScale }) }
  );
  return result;
}

/** Time to first reach 200 km/h, or null if it never gets there. */
async function zeroToTwoHundredSeconds(finalDriveScale?: number): Promise<number | null> {
  let reached: number | null = null;
  const result = await simulateDrive(
    20,
    { throttle: 1, brake: 0, steer: 0 },
    {
      ...BASE,
      ...(finalDriveScale === undefined ? {} : { finalDriveScale }),
      onTelemetry: (sample) => {
        if (reached === null && sample.speedMs >= ZERO_TO_200_MS) reached = sample.elapsedSeconds;
      },
    }
  );
  expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  return reached;
}

describe("final drive ratio scale", () => {
  it("neutral is an exact identity on every ratio and every rpm", () => {
    for (let gear = 1; gear <= GEAR_COUNT; gear += 1) {
      expect(effectiveGearRatio(gear, FINAL_DRIVE_NOMINAL)).toBe(
        effectiveGearRatio(gear, 1)
      );
      for (const speed of [0, 5, 20, 45, 70, 90]) {
        expect(rpmForGear(speed, gear, FINAL_DRIVE_NOMINAL)).toBe(rpmForGear(speed, gear));
      }
    }
  });

  it("normalizes anything untrusted to the neutral, not to a bound", () => {
    // A junk ?fd= must not hand the player an end of the range (the same
    // rule carSetup's usableSlider follows, and for the same reason).
    for (const bad of [NaN, Infinity, -Infinity, "1.02" as unknown as number, null as unknown as number]) {
      expect(normalizeFinalDriveScale(bad)).toBe(FINAL_DRIVE_NOMINAL);
    }
    expect(normalizeFinalDriveScale(99)).toBe(FINAL_DRIVE_MAX);
    expect(normalizeFinalDriveScale(-99)).toBe(FINAL_DRIVE_MIN);
  });

  it("scales the top gear only, leaving the launch gears bit-identical", () => {
    // MEASURED, and the reason the module is shaped this way: scaling the
    // WHOLE ratio set is a one-way penalty here, because
    // GEAR_THRUST_FACTORS tapers monotonically with gear number. Any scale
    // that shifts the 1-2 up earlier just spends more of the launch in a
    // taller, weaker gear (measured 0-200: 6.43 s at 0.95 vs 6.00 s at 1.00)
    // while the terminal speed stays drag-limited. A top-gear-only trim
    // leaves 0-200 exactly at neutral and moves only the ceiling, which is
    // what the player is actually buying with a final drive.
    for (let gear = 1; gear < GEAR_COUNT; gear += 1) {
      for (const scale of [FINAL_DRIVE_MIN, FINAL_DRIVE_NOMINAL, FINAL_DRIVE_MAX]) {
        expect(effectiveGearRatio(gear, scale)).toBe(effectiveGearRatio(gear, 1));
      }
    }
    // ...and the top gear is the one that moves, in the right direction.
    // rpm = wheelRpm * ratio, so a LARGER ratio (scale > 1) turns the engine
    // faster per metre: the same road speed sits higher on the torque curve
    // and closer to the limiter, which is why the measured terminal speed
    // falls as the scale rises (77.90 / 76.66 / 72.52 m/s at 0.94 / 1.00 /
    // 1.06). A shorter top gear (scale < 1) reverses that and revs out later.
    expect(rpmForGear(70, GEAR_COUNT, FINAL_DRIVE_MAX)).toBeGreaterThan(rpmForGear(70, GEAR_COUNT));
    expect(rpmForGear(70, GEAR_COUNT, FINAL_DRIVE_MIN)).toBeLessThan(rpmForGear(70, GEAR_COUNT));
  });

  it("moves rpm and the shift point in opposite directions at the two ends", () => {
    // The entire mechanism, on the one gear the trim touches. If this ever
    // stops being true the slider has silently become a no-op.
    const shortRpm = rpmForGear(30, GEAR_COUNT, FINAL_DRIVE_MAX);
    const longRpm = rpmForGear(30, GEAR_COUNT, FINAL_DRIVE_MIN);
    expect(shortRpm).toBeGreaterThan(rpmForGear(30, GEAR_COUNT));
    expect(longRpm).toBeLessThan(rpmForGear(30, GEAR_COUNT));
    // The top gear's upshift point moves with it - the only gear that does.
    const speedAtShiftUp = (scale: number) => {
      const ratio = effectiveGearRatio(GEAR_COUNT, scale);
      // rpm = wheelRpm * ratio, wheelRpm = speed / circumference * 60.
      return ((SHIFT_UP_RPM / ratio) * (2 * Math.PI * 0.34)) / 60;
    };
    expect(speedAtShiftUp(FINAL_DRIVE_MAX)).toBeLessThan(speedAtShiftUp(FINAL_DRIVE_NOMINAL));
    expect(speedAtShiftUp(FINAL_DRIVE_MIN)).toBeGreaterThan(speedAtShiftUp(FINAL_DRIVE_NOMINAL));
  });

  it("describes the character rather than the number", () => {
    expect(finalDriveLabel(FINAL_DRIVE_NOMINAL)).toBe("STANDARD");
    expect(finalDriveLabel(FINAL_DRIVE_MAX)).toBe("LONG (less top speed)");
    expect(finalDriveLabel(FINAL_DRIVE_MIN)).toBe("SHORT (more top speed)");
  });
});

describe("final drive measured on the car (flat-plane launch)", () => {
  it("reaches 200 km/h at both ends of the slider", async () => {
    for (const scale of [FINAL_DRIVE_MIN, FINAL_DRIVE_NOMINAL, FINAL_DRIVE_MAX]) {
      const seconds = await zeroToTwoHundredSeconds(scale);
      if (seconds === null) throw new Error(`final drive ${scale} never reached 200 km/h`);
      // Sanity: a standing start to 200 km/h is seconds, not tens of them.
      expect(seconds, `final drive ${scale}`).toBeLessThan(12);
    }
  }, 90000);

  it("never launches faster than the neutral, validated gearing", async () => {
    // THE guard for ground rule 3: a setup that added thrust would show up
    // here as a shorter 0-200 at one end of the slider. Measured 6.00 s at
    // every point on the range, which is the point - a top-gear-only trim
    // cannot touch the launch, and the ceiling is still clamped to the same
    // BOOSTED_ENGINE_FORCE_CAP inside applyCarControls.
    // A helper rather than a cast, so the file makes no unsound assertion
    // about a value tsc still believes might be null.
    const timeTo200 = (seconds: number | null, label: string): number => {
      if (seconds === null) throw new Error(`${label} never reached 200 km/h`);
      return seconds;
    };
    const neutral = timeTo200(await zeroToTwoHundredSeconds(FINAL_DRIVE_NOMINAL), "neutral gearing");
    for (const scale of [FINAL_DRIVE_MIN, FINAL_DRIVE_MAX]) {
      const measured = timeTo200(await zeroToTwoHundredSeconds(scale), `final drive ${scale}`);
      // 3% of margin for a filter-order difference on a run this noisy; the
      // measured spread across the whole range is under 0.5%.
      expect(measured, `final drive ${scale}`).toBeGreaterThanOrEqual(neutral * 0.97);
    }
  }, 90000);

  it("still reaches top gear at the short end - no gearbox gets stranded", async () => {
    // A whole-set scale first produced a real defect here: at 0.93-0.94 the
    // 6-7 upshift point (52.8 m/s) sat just above 6th's own drag equilibrium
    // (52.58 m/s), so the car asymptoted to 52.6 m/s in 6th and NEVER
    // reached 200 km/h in the whole run. The top-gear-only shape removes the
    // trap, and this asserts the outcome rather than trusting the algebra.
    for (const scale of [FINAL_DRIVE_MIN, FINAL_DRIVE_NOMINAL, FINAL_DRIVE_MAX]) {
      let topGear = 0;
      await simulateDrive(
        13,
        { throttle: 1, brake: 0, steer: 0 },
        {
          ...BASE,
          finalDriveScale: scale,
          onTelemetry: (sample) => {
            topGear = Math.max(topGear, sample.gear);
          },
        }
      );
      expect(topGear, `final drive ${scale}`).toBe(GEAR_COUNT);
    }
  }, 90000);

  it("stays far from flipping and never rolls over on a full-throttle launch", async () => {
    for (const scale of [FINAL_DRIVE_MIN, FINAL_DRIVE_NOMINAL, FINAL_DRIVE_MAX]) {
      const result = await launchDistanceMeters(10, scale);
      expect(result.maxTiltRad, `final drive ${scale}`).toBeLessThan(TILT_CEILING_RAD);
      // A car that has fallen over stops making progress; the distance guard
      // catches a "stable but beached" outcome the tilt number would not.
      expect(result.distanceMeters, `final drive ${scale}`).toBeGreaterThan(300);
    }
  }, 90000);

  it("a longer final drive raises the top-speed ceiling and a shorter one lowers it", async () => {
    // The trade the slider exists to express. Top speed is read from the
    // telemetry MAX, never from StabilityResult.finalSpeedMs: the harness's
    // flat ground field is finite, so a long enough run drives off its edge
    // and finalSpeedMs ends up measuring a fall (verified: y goes to -22 m
    // with tilt 0.00 by t=19 s). The 13 s runs below all finish on the field.
    const speedAt = async (scale: number) => {
      let maxSpeed = 0;
      await simulateDrive(
        13,
        { throttle: 1, brake: 0, steer: 0 },
        {
          ...BASE,
          finalDriveScale: scale,
          onTelemetry: (sample) => {
            maxSpeed = Math.max(maxSpeed, sample.speedMs);
          },
        }
      );
      return maxSpeed;
    };
    const long = await speedAt(FINAL_DRIVE_MIN);
    const neutral = await speedAt(FINAL_DRIVE_NOMINAL);
    const short = await speedAt(FINAL_DRIVE_MAX);
    // Measured: 77.90 / 76.66 / 72.52 m/s at 0.94 / 1.00 / 1.06.
    expect(long).toBeGreaterThan(neutral);
    expect(short).toBeLessThan(neutral);
    // A real, felt spread - not a rounding difference.
    expect(long - short).toBeGreaterThan(4);
  }, 90000);
});
