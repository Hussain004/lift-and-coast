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

// Reported as "the hood lifts up and then it starts galloping like crazy" -
// only on the real track, never in this project's shorter/flat-plane tests.
// Root cause (found via Rapier's per-wheel wheelSuspensionLength/
// wheelSuspensionForce): under sustained full throttle the rear suspension
// needed more compression than its travel limit allowed, so it sat pinned
// at that hard mechanical floor - an unstable state where, on the real
// track trimesh (never on the idealized flat test plane), the force
// computation would occasionally glitch to exactly 0 for a couple of steps
// and kick the chassis pitch by over 0.3 rad in a single 1/60s step. Fixed
// by giving the rear more suspension travel (see REAR_MAX_SUSPENSION_TRAVEL
// in vehicle.ts) so it reaches a real equilibrium instead of bottoming out.
//
// This needs the REAL track trimesh (not the default flat plane) and a
// run long enough to reach a sustained cruise, which is why none of the
// existing short/flat-plane stability tests caught it - both matter here.
// Runs at both normal and boosted (Push-to-Pass) throttle since boost is a
// separate multiplier applyCarControls clamps to a safe ceiling (see
// BOOSTED_ENGINE_FORCE_CAP in vehicle.ts) - this confirms that ceiling is
// actually low enough to avoid retriggering the same suspension floor.
describe("suspension does not bottom out under sustained throttle on the real track", () => {
  it.each([
    ["normal throttle", 1],
    ["boosted (Push-to-Pass) throttle", 1.6],
  ])("%s: no single-step tilt discontinuity over 20s straight", async (_label, boostMultiplier) => {
    const result = await simulateDrive(
      20,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        boostMultiplier,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        track,
      }
    );
    // A bottomed-out suspension glitch kicked this well past 0.3 rad in a
    // single step; ordinary suspension response (launch squat, grass/curb
    // bumps) stays under 0.02 (see grassTrackTransition.test.ts).
    expect(result.maxTiltStepRad).toBeLessThan(0.02);
  }, 30000);
});
