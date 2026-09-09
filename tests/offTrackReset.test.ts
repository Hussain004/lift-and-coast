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

// Before the off-track reset guard existed, sustained straight-line
// full-throttle driving eventually ran the car past the finite ground
// plane's edge and crashed Rapier's WASM physics pipeline outright (an
// "unreachable" panic, not a thrown JS error a test could easily assert on
// otherwise) - reachable in well under a minute since nothing was ever
// bounding how far off-track the car could get. This runs well past that
// old crash point and just needs simulateDrive to resolve without throwing.
describe("off-track reset guard", () => {
  it("survives 90s of straight-line full throttle without crashing the physics engine", async () => {
    const result = await simulateDrive(90, { throttle: 1, brake: 0, steer: 0 }, TUNING);
    expect(result.maxTiltRad).toBeLessThan(0.6);
  }, 30000);
});
