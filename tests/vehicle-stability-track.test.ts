import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

const TUNING = {
  engineForce: DEFAULT_ENGINE_FORCE,
  brakeForce: DEFAULT_BRAKE_FORCE,
  stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
  track,
};

// The flat-plane suite (vehicle-stability.test.ts) tests an infinite analytic
// cuboid the game never actually drives on. A 2m-segment trimesh gives raycast
// wheels a different triangle to hit every frame, and contacts near shared
// edges can jitter in ways a flat plane can't - exactly the kind of noise
// that can push a marginal suspension into a flip. This re-runs the same
// scenarios on the real Silverstone collider, spawned at its real start line.
const FLIP_THRESHOLD_RAD = 0.6;

describe("vehicle stability on real Silverstone trimesh", () => {
  it("does not tip over holding full throttle for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 0 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
    // currentVehicleSpeed()'s sign isn't a reliable direction indicator
    // (the real HUD already takes Math.abs() of it) - check magnitude.
    expect(Math.abs(result.finalSpeedMs)).toBeGreaterThan(10);
  }, 20000);

  // Full steering lock at full throttle runs the car off the ribbon within a
  // couple of seconds - this exercises grass recovery (the ground cuboid,
  // same as the flat-plane suite), not trimesh contact. See the "stays on
  // the ribbon" test below for the case that actually stays on the mesh.
  it("does not tip over holding throttle and full steering lock for 8 seconds", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 1 },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  // Moderate steer that actually stays on the ribbon for its whole duration
  // (verified empirically: steer 0.3 keeps maxOffTrackMeters at 0 through
  // ~2s before the car runs wide - shorter than it used to be, since the
  // car covers much more ground per second at the current engine force) -
  // the real discriminator between trimesh jitter and the flat-plane case,
  // unlike the full-lock scenarios above.
  it("stays on the ribbon and upright while cornering under throttle", async () => {
    const result = await simulateDrive(
      2,
      { throttle: 1, brake: 0, steer: 0.3 },
      TUNING
    );
    expect(result.maxOffTrackMeters).toBeLessThan(0.5);
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

  // Braking hard from real speed was never exercised before this engine
  // force - it turns out slamming full brake instantly at speed pitches the
  // chassis past the flip threshold (a raw-input characteristic of the
  // raycast suspension, not something fixed at this layer). The real input
  // path (useDriveInput.ts) ramps brake up over 0.5s specifically to avoid
  // this; this scenario reproduces that ramp to prove the actual gameplay
  // path - not just the raw physics API - stays safe.
  it("does not tip over braking hard from speed with a realistic (ramped) brake input", async () => {
    const BRAKE_RAMP_SECONDS = 0.5;
    const result = await simulateDrive(
      4,
      (t) => {
        if (t < 3) return { throttle: 1, brake: 0, steer: 0 };
        return { throttle: 0, brake: Math.min(1, (t - 3) / BRAKE_RAMP_SECONDS), steer: 0 };
      },
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  // Also runs the car off the ribbon onto grass well before the steer input
  // kicks in at t=20 - same grass-recovery caveat as the full-lock test above.
  it("does not tip over steering hard after building up speed", async () => {
    const result = await simulateDrive(
      25,
      (t) => ({ throttle: 1, brake: 0, steer: t > 20 ? 1 : 0 }),
      TUNING
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);

  // Stance/damping fixes came after the self-righting torque was added at a
  // much lower engine force. Confirms the passive stance (not the torque
  // assist) is what actually keeps the car up in the current tuning - if
  // this fails, the torque is load-bearing and shouldn't be touched blind.
  it("stays upright on the real track even with the stabilizing torque disabled", async () => {
    const result = await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 0 },
      { ...TUNING, stabilizeStrength: 0 }
    );
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);
});
