import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import {
  TYRE_PRESSURE_GRIP_RANGE,
  tyrePressureGripScale,
} from "../lib/physics/tireModel";
import { pressureWarmupTimeConstantSeconds } from "../lib/race/strategy";
import { TYRE_PRESSURE_NOMINAL, setupTyreGripScale } from "../lib/physics/carSetup";

/**
 * Measurement test for the tyre pressure setup slider (roadmap 11.11).
 *
 * Pressure is display-level and deliberately tiny (+/-3% of grip, see
 * lib/physics/tireModel.ts's TYRE_PRESSURE_GRIP_RANGE), so the physics
 * assertions are about BOUNDS rather than about a performance delta: the
 * whole slider has to stay inside the envelope the AI gates measured, and the
 * warm-up half has to actually be a trade rather than a free lunch.
 */

const BASE = {
  engineForce: DEFAULT_ENGINE_FORCE,
  brakeForce: DEFAULT_BRAKE_FORCE,
  stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
};
const FLIP_THRESHOLD_RAD = 0.6;
const TILT_CEILING_RAD = 0.3;

/** Lap-ish distance and top speed with a full-throttle standing start. */
async function measure(tyrePressure: number | undefined) {
  let maxSpeed = 0;
  let reached: number | null = null;
  const result = await simulateDrive(
    13,
    { throttle: 1, brake: 0, steer: 0 },
    {
      ...BASE,
      ...(tyrePressure === undefined ? {} : { tyrePressure }),
      onTelemetry: (sample) => {
        maxSpeed = Math.max(maxSpeed, sample.speedMs);
        if (reached === null && sample.speedMs >= 200 / 3.6) reached = sample.elapsedSeconds;
      },
    }
  );
  return { ...result, maxSpeed, zeroTo200: reached };
}

describe("tyre pressure grip scale", () => {
  it("is exactly neutral at the nominal pressure, warm or cold", () => {
    for (const warmth of [0, 0.5, 1]) {
      expect(tyrePressureGripScale(TYRE_PRESSURE_NOMINAL, warmth)).toBe(1);
    }
    // The setup helper agrees, and the default setup is the neutral one.
    expect(setupTyreGripScale({ rideHeight: 0.5, aeroTrim: 1 })).toBe(1);
  });

  it("stays inside the declared +/-3% band across the whole slider", () => {
    for (let k = 0; k <= 20; k += 1) {
      const pressure = k / 20;
      for (const warmth of [0, 0.25, 0.5, 0.75, 1]) {
        const scale = tyrePressureGripScale(pressure, warmth);
        expect(scale).toBeGreaterThanOrEqual(1 - TYRE_PRESSURE_GRIP_RANGE);
        expect(scale).toBeLessThanOrEqual(1 + TYRE_PRESSURE_GRIP_RANGE);
      }
    }
  });

  it("is monotonic in pressure once the tyre is at least half warm", () => {
    // Monotonic from warmth 0.5 upward, where the warm credit reaches
    // neutral. Below that the order deliberately INVERTS - a cold low-pressure
    // tyre is the worst of the lot, a floppy carcass with no contact patch -
    // which is the whole reason the warm-up half of this slider exists, and
    // is asserted separately below rather than hidden by a blanket
    // monotonicity claim.
    for (const warmth of [0.5, 0.75, 1]) {
      let previous = Infinity;
      for (let k = 0; k <= 20; k += 1) {
        const scale = tyrePressureGripScale(k / 20, warmth);
        expect(scale).toBeLessThan(previous);
        previous = scale;
      }
    }
  });

  it("peaks at neutral while cold, then moves to the low end once warm", () => {
    // Cold, the curve peaks at the NOMINAL pressure: a low-pressure tyre is
    // a floppy carcass with no contact patch yet (below neutral), and a
    // high-pressure one has a small one (also below). Warm, the peak moves
    // to the low end. This is what makes the slider a real choice - the
    // pressure that is best on a cold tyre is not the pressure that is best
    // on a hot one, which is the qualifying-versus-stint trade.
    const peakPressureWhileCold = (() => {
      let best = 0;
      let bestScale = -Infinity;
      for (let k = 0; k <= 20; k += 1) {
        const scale = tyrePressureGripScale(k / 20, 0);
        if (scale > bestScale) {
          bestScale = scale;
          best = k / 20;
        }
      }
      return best;
    })();
    expect(peakPressureWhileCold).toBe(TYRE_PRESSURE_NOMINAL);
    // Warm, the low end is the best point on the slider.
    expect(tyrePressureGripScale(0, 1)).toBeGreaterThan(tyrePressureGripScale(1, 1));
    // No end of the slider is a free upgrade on a cold tyre.
    expect(tyrePressureGripScale(0, 0)).toBeLessThan(1);
    expect(tyrePressureGripScale(1, 0)).toBeLessThan(1);
    // The crossover: at one third of the way through the warm-up the
    // low-pressure end sits exactly on neutral, and passes it after that.
    expect(tyrePressureGripScale(0, 1 / 3)).toBeCloseTo(1, 10);
    expect(tyrePressureGripScale(0, 0.5)).toBeGreaterThan(1);
  });

  it("makes the low-pressure grip conditional on warming up", () => {
    // THE reason this is a decision rather than a free lunch: the grippy end
    // is the slow end. A cold low-pressure tyre must not simply be a better
    // tyre, or the slider would be a one-sided upgrade.
    const coldLow = tyrePressureGripScale(0, 0);
    const warmLow = tyrePressureGripScale(0, 1);
    expect(coldLow).toBeLessThan(warmLow);
    // Cold, the grippy end is the WORST end (1 - 1.5%); warm, it is the best
    // (1 + 3%). The slider pays out over a stint, not on the formation lap.
    expect(coldLow).toBeCloseTo(0.985, 10);
    expect(warmLow).toBeCloseTo(1.03, 10);
    // The high-pressure end gives up peak grip at every warmth.
    expect(tyrePressureGripScale(1, 0)).toBeLessThan(1);
    expect(tyrePressureGripScale(1, 1)).toBeLessThan(1);
  });

  it("never produces a non-finite or non-positive multiplier", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(tyrePressureGripScale(bad))).toBe(true);
    }
    for (let k = 0; k <= 20; k += 1) {
      expect(tyrePressureGripScale(k / 20)).toBeGreaterThan(0.9);
    }
  });
});

describe("pressure warm-up time constant", () => {
  it("is the baseline constant at neutral, and for an unset pressure", () => {
    // Undefined is what every AI car and every pre-existing caller passes,
    // so this exact equality is what keeps them unchanged.
    expect(pressureWarmupTimeConstantSeconds(TYRE_PRESSURE_NOMINAL)).toBe(18);
    expect(pressureWarmupTimeConstantSeconds(undefined)).toBe(18);
    expect(pressureWarmupTimeConstantSeconds(NaN)).toBe(18);
  });

  it("is monotonic: higher pressure heats sooner", () => {
    let previous = Infinity;
    for (let k = 0; k <= 20; k += 1) {
      const seconds = pressureWarmupTimeConstantSeconds(k / 20);
      expect(seconds).toBeLessThan(previous);
      previous = seconds;
    }
    expect(pressureWarmupTimeConstantSeconds(0)).toBeGreaterThan(18);
    expect(pressureWarmupTimeConstantSeconds(1)).toBeLessThan(18);
  });
});

describe("tyre pressure measured on the car (flat-plane launch)", () => {
  it("stays far from flipping at both ends of the slider", async () => {
    for (const pressure of [0, TYRE_PRESSURE_NOMINAL, 1]) {
      const result = await measure(pressure);
      expect(result.maxTiltRad, `pressure ${pressure}`).toBeLessThan(TILT_CEILING_RAD);
      expect(result.maxTiltRad, `pressure ${pressure}`).toBeLessThan(FLIP_THRESHOLD_RAD);
    }
  }, 90000);

  it("still reaches 200 km/h everywhere, and moves no more than the declared band", async () => {
    // A +/-3% grip band is not going to show up as a large lap-time delta on
    // a straight line, so the bound here is the point: the slider must not
    // become a performance slider by accident. 8% of margin on 0-200 is
    // roughly 2.5x the entire declared grip range.
    // A helper rather than a cast: expect(...).not.toBeNull() does not narrow
    // the type for tsc, and `as number` on a `number | null` is exactly the
    // assertion this file should not be making.
    const timeTo200 = (result: { zeroTo200: number | null }, label: string): number => {
      if (result.zeroTo200 === null) throw new Error(`${label} never reached 200 km/h`);
      return result.zeroTo200;
    };
    const baselineTime = timeTo200(await measure(TYRE_PRESSURE_NOMINAL), "neutral pressure");
    for (const pressure of [0, 1]) {
      const result = await measure(pressure);
      const ratio = timeTo200(result, `pressure ${pressure}`) / baselineTime;
      expect(ratio, `pressure ${pressure} vs neutral`).toBeGreaterThan(0.92);
      expect(ratio, `pressure ${pressure} vs neutral`).toBeLessThan(1.08);
      // And it is not secretly a thrust change: the car still reaches a real
      // speed down the straight, so nothing about the drivetrain moved.
      expect(result.maxSpeed, `pressure ${pressure}`).toBeGreaterThan(60);
    }
  }, 90000);
});
