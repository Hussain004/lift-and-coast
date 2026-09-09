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
    expect(result.finalSpeedMs).toBeGreaterThan(10);
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
