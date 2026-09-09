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

// Confirms the car actually leans under cornering load (feedback: the car
// felt "glued to the road" at the old suspension stiffness of 30). A
// headless sweep found neither the stabilizing torque nor angular damping
// were the cause - tilt during hard cornering was essentially unchanged
// whether the torque was fully disabled or damping was cut from 6 to 1.
// Lowering suspension stiffness (see SUSPENSION_STIFFNESS in vehicle.ts)
// was what actually produced visible roll. This is a lower bound, not an
// exact target - it just guards against silently drifting back to "flat."
describe("cornering roll", () => {
  it("visibly leans under moderate cornering load, not just a few degrees", async () => {
    const result = await simulateDrive(
      4,
      (t) => ({ throttle: 1, brake: 0, steer: t < 1 ? 0 : 0.5 }),
      TUNING
    );
    expect(result.maxTiltRad).toBeGreaterThan(0.1);
    expect(result.maxTiltRad).toBeLessThan(0.6);
  }, 20000);
});
