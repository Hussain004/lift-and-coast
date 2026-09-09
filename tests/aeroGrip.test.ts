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
const FLIP_THRESHOLD_RAD = 0.6;

// Confirms low-drag mode actually bleeds cornering grip (plan section 5:
// "running low-drag mode through a corner bleeds grip and punishes you"),
// not just in theory but in the harness's own numbers. A moderate steer
// input (0.3) at low speed showed no measurable difference between modes -
// downforce is under 1.5% of static weight at cornering speed either way -
// so this uses a harder steer input after building speed, where the
// aeroGripMultiplier penalty (see aero.ts) actually shows up.
describe("active aero grip penalty", () => {
  const buildSpeedThenHardSteer = (t: number) => ({
    throttle: 1,
    brake: 0,
    steer: t < 3 ? 0 : 0.9,
  });

  it("low-drag mode turns in less than high-downforce under hard steer", async () => {
    const highDownforce = await simulateDrive(6, buildSpeedThenHardSteer, {
      ...TUNING,
      aeroMode: "high-downforce",
    });
    const lowDrag = await simulateDrive(6, buildSpeedThenHardSteer, {
      ...TUNING,
      aeroMode: "low-drag",
    });
    // netYawChangeRad is the robust signal here: at the current engine
    // force both modes run well off the ribbon under hard steer, and
    // maxOffTrackMeters stops being monotonic with grip once track geometry
    // (which corner, past which apex) dominates over the aero difference.
    expect(lowDrag.netYawChangeRad).toBeLessThan(highDownforce.netYawChangeRad);
  }, 20000);

  it("stays upright in low-drag mode even under hard steer", async () => {
    const result = await simulateDrive(6, buildSpeedThenHardSteer, {
      ...TUNING,
      aeroMode: "low-drag",
    });
    expect(result.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
  }, 20000);
});
