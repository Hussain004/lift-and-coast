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
// was what actually produced visible roll.
//
// The first version of this test (threshold 0.1) was passing on an
// underdamped suspension: the original low compression/relaxation values
// (0.6/0.7) hadn't been re-tuned for the lower stiffness, so the "roll" it
// measured was largely a spring-back overshoot that then bounced - the
// same oscillation reported as the car pitching front-and-back under
// throttle boost. Raising compression/relaxation (see createCarController)
// killed that oscillation (verified via a per-frame pitch trace: the boost
// transient now settles smoothly instead of overshooting and springing
// back), which also brought this step-response peak down to ~0.065-0.07 -
// closer to the original stiffness=30 baseline than the underdamped
// version suggested, since a good chunk of that number was the bounce
// itself. This lower bound reflects the properly-damped reality.
describe("cornering roll", () => {
  it("leans under moderate cornering load without a flat, zero-roll response", async () => {
    const result = await simulateDrive(
      4,
      (t) => ({ throttle: 1, brake: 0, steer: t < 1 ? 0 : 0.5 }),
      TUNING
    );
    expect(result.maxTiltRad).toBeGreaterThan(0.045);
    expect(result.maxTiltRad).toBeLessThan(0.6);
  }, 20000);
});
