import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  resolveYawDampingTorque,
} from "../lib/physics/vehicle";

const TUNING = {
  engineForce: DEFAULT_ENGINE_FORCE,
  brakeForce: DEFAULT_BRAKE_FORCE,
  stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
};

describe("resolveYawDampingTorque", () => {
  it("ignores everything a car does while racing", () => {
    // 1.2g at 60 m/s is ~1.5 rad/s; hairpin turn-in peaks under 2 rad/s.
    expect(resolveYawDampingTorque(0)).toBe(0);
    expect(resolveYawDampingTorque(1.5)).toBe(0);
    expect(resolveYawDampingTorque(-1.9)).toBe(0);
    expect(resolveYawDampingTorque(2.2)).toBe(0);
  });

  it("opposes a spin, harder the faster it spins", () => {
    const gentle = resolveYawDampingTorque(2.5);
    const full = resolveYawDampingTorque(4.5);
    // Opposite sign to the spin: damping, never drive.
    expect(gentle).toBeLessThan(0);
    expect(resolveYawDampingTorque(-2.5)).toBeGreaterThan(0);
    expect(full).toBeLessThan(gentle);
    // Capped, so it can never out-muscle the tires.
    expect(resolveYawDampingTorque(12)).toBe(full);
  });
});

// A flipped/tipped-over car has tilted roughly 90 degrees (pi/2) or more
// from upright. Stay well clear of that so this catches real instability,
// not just normal suspension lean.
const FLIP_THRESHOLD_RAD = 0.6;

describe("vehicle stability (headless)", () => {
  it("does not tip over holding full throttle for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 0 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
    // Guards against the car being technically stable but crawling - e.g.
    // linear damping large enough relative to engine force to cap speed at
    // a walking pace, which is exactly as undrivable as flipping.
    expect(result.distanceMeters).toBeGreaterThan(45);
    // currentVehicleSpeed()'s sign isn't a reliable direction indicator
    // (the real HUD already takes Math.abs() of it) - check magnitude.
    expect(Math.abs(result.finalSpeedMs)).toBeGreaterThan(10);
  }, 20000);

  it("does not tip over holding throttle and full steering lock for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 1 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  it("does not tip over holding the brake from a standstill", async () => {
    const result = await simulateDrive(
      3,
      { throttle: 0, brake: 1, steer: 0 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  it("does not tip over steering hard after building up speed", async () => {
    // The highest-lateral-load case a player hits: near top speed, then
    // full steering lock with no easing in.
    const result = await simulateDrive(
      25,
      (t) => ({ throttle: 1, brake: 0, steer: t > 20 ? 1 : 0 }),
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);
});

describe("hard braking from top speed (rear-lift regression)", () => {
  // Braking from ~60 m/s used to hold both rear wheels off the ground for
  // up to a second (ABS-on ramp) or flip outright (instant ABS-off stab,
  // maxTilt 1.03) - the "back lifts up" report. These pin the fix at twice
  // the margin: tilt stays 2x under the flip threshold everywhere, and the
  // high-downforce cases keep every wheel on the ground throughout.
  // Low-drag keeps scattered airborne steps (measured worst 0.3s
  // continuous) - its halved tire friction locks wheels sooner - so it
  // asserts the bounded tilt plus a sub-second worst run instead of zero.
  async function brakeFromVmax(
    rampSeconds: number,
    aeroMode: "high-downforce" | "low-drag"
  ) {
    const rearAirborne: boolean[] = [];
    const result = await simulateDrive(
      26,
      (t) => {
        if (t < 14) return { throttle: 1, brake: 0, steer: 0 };
        const brake = rampSeconds <= 0 ? 1 : Math.min(1, (t - 14) / rampSeconds);
        return { throttle: 0, brake, steer: 0 };
      },
      {
        ...TUNING,
        aeroMode,
        onTelemetry: (s) => {
          if (s.elapsedSeconds >= 14) {
            rearAirborne.push(!s.wheels[2].isInContact && !s.wheels[3].isInContact);
          }
        },
      }
    );
    let run = 0;
    let worstRunSteps = 0;
    for (const airborne of rearAirborne) {
      if (airborne) {
        run++;
        worstRunSteps = Math.max(worstRunSteps, run);
      } else {
        run = 0;
      }
    }
    return { result, rearAirborneSteps: rearAirborne.filter(Boolean).length, worstRunSeconds: worstRunSteps / 60 };
  }

  it("keeps all wheels down braking instantly from top speed", async () => {
    const { result, rearAirborneSteps } = await brakeFromVmax(0, "high-downforce");
    expect(result.maxTiltRad).toBeLessThan(0.3);
    expect(rearAirborneSteps).toBe(0);
  }, 120000);

  it("keeps all wheels down braking with the gameplay ramp from top speed", async () => {
    const { result, rearAirborneSteps } = await brakeFromVmax(0.5, "high-downforce");
    expect(result.maxTiltRad).toBeLessThan(0.3);
    expect(rearAirborneSteps).toBe(0);
  }, 120000);

  it("stays far from flipping braking instantly from top speed in low-drag mode", async () => {
    const { result, worstRunSeconds } = await brakeFromVmax(0, "low-drag");
    expect(result.maxTiltRad).toBeLessThan(0.3);
    expect(worstRunSeconds).toBeLessThan(1);
  }, 120000);

  it("stays far from flipping braking with the gameplay ramp in low-drag mode", async () => {
    const { result, worstRunSeconds } = await brakeFromVmax(0.5, "low-drag");
    expect(result.maxTiltRad).toBeLessThan(0.3);
    expect(worstRunSeconds).toBeLessThan(1);
  }, 120000);
});
