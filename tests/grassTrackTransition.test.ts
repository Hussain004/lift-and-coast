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

// Reported as the car "twitching" every so often during normal driving -
// tilting forward then back, like a horse rearing up - despite the player
// not feeling like they were off-track. That's consistent, not
// contradictory: checkTrackLimits measures the chassis CENTER, but the
// wheels sit at x=+-0.82 (CAR_WHEELS) with the chassis itself 0.9 half-wide
// - so a car reading "on track" at its center can still have an outer wheel
// up to ~0.8m past the ribbon edge on a normal corner exit, catching
// whatever step exists at the boundary without the player ever seeing an
// off-track warning.
//
// Root cause: the grass ground plane sat a full 5cm below the track
// trimesh (see GRASS_BELOW_TRACK_METERS in lib/tracks/mesh.ts), a literal
// curb a wheel had to climb crossing back onto the track - completely
// normal racing-line driving, not a mistake. Confirmed via a per-frame
// trace: tilt jumped ~0.03 rad in a single 1/60s step exactly at the moment
// offTrackMeters (measured from center) crossed back to 0 - meaning a wheel
// hit the step even earlier than that, while the center still read as
// on-track.
//
// This cycles steer on and off every 5s (2s cornering, 3s straight) for
// long enough to guarantee at least one grass-to-track crossing, and
// asserts no single-timestep tilt jump - a real discontinuity, not gradual
// suspension response, which changes by a tiny fraction of this per step
// even under hard cornering or braking (see existing scenarios' numbers).
// Measured at 0.0036 with the current 1cm gap versus 0.0263 at the old
// 5cm gap, so 0.01 has real margin in both directions.
describe("grass/track surface transition", () => {
  it("does not produce a tilt discontinuity crossing back onto the track", async () => {
    const plan = (t: number) => ({
      throttle: 1,
      brake: 0,
      steer: t % 5 < 2 ? 0.35 : 0,
    });
    const result = await simulateDrive(45, plan, TUNING);
    expect(result.maxOffTrackMeters).toBeGreaterThan(0);
    expect(result.maxTiltStepRad).toBeLessThan(0.01);
  }, 30000);
});
