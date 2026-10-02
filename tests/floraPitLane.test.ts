import { describe, expect, it } from "vitest";
import { getTrack } from "../lib/tracks/trackData";
import { getPitLane, PIT_LANE_HALF_WIDTH } from "../lib/tracks/pitLane";
import { buildFlora } from "../lib/tracks/flora";
import { TRACKS } from "../lib/tracks/registry";

/**
 * Regression: no tree may stand on the pit lane.
 *
 * flora.ts excluded mapped buildings, grandstands and attractions, but never
 * the pit lane - so every circuit dropped a handful of trees onto the tarmac
 * beside the main straight, which is exactly where planting wants to be.
 * Measured before the fix, per circuit: Sochi 3, Sepang 2, Budapest 2, Monza 2,
 * Spa 2, Suzuka 2, Yas Marina 1.
 *
 * A handful of circuits is asserted rather than all thirty: buildFlora builds
 * real merged geometry and costs ~0.5s a circuit, so covering every one would
 * add ~15s to the suite for no extra signal - the excluded set is per-circuit
 * and the mechanism is shared.
 */

/** The circuits that were measured as affected, plus one that was already clean
 *  so a regression that simply deletes all planting cannot pass as a fix. */
const AFFECTED = ["sepang", "sochi", "budapest", "yasmarina", "monza", "spa", "suzuka"];
const CONTROL = "silverstone";

function treesInsidePitLane(trackId: string): number {
  const track = getTrack(trackId);
  const lane = getPitLane(track);
  if (!lane) throw new Error(`${trackId} has no pit lane`);
  const trees = buildFlora(track).flatMap((f) => f.instances);
  let inside = 0;
  for (const t of trees) {
    for (const [lx, , lz] of lane.points) {
      // Inside the painted lane plus a small slack, so a tree that has merely
      // crept to the very edge still fails the test.
      if (Math.hypot(t.x - lx, t.z - lz) < PIT_LANE_HALF_WIDTH + 1) {
        inside += 1;
        break;
      }
    }
  }
  return inside;
}

describe("flora keeps off the pit lane", () => {
  for (const id of AFFECTED) {
    it(`${id} plants nothing on the pit lane`, () => {
      expect(treesInsidePitLane(id)).toBe(0);
    });
  }

  it("still plants trees on a circuit that was already clean", () => {
    // The failure mode this guards against: "fixing" the bug by removing all
    // planting, which passes a naive zero-trees-in-the-lane assertion while
    // making every circuit a parking lot.
    const track = getTrack(CONTROL);
    const trees = buildFlora(track).flatMap((f) => f.instances);
    expect(trees.length).toBeGreaterThan(50);
    expect(treesInsidePitLane(CONTROL)).toBe(0);
  });

  it("keeps planting density, not just avoidance", () => {
    // Density is maintained by the retry loop (up to targetCount*12 attempts),
    // so excluding the pit lane should move trees a little, not thin the
    // circuit out. A circuit that lost most of its planting would still pass a
    // zero-in-the-lane check.
    const track = getTrack("sepang");
    const config = track.id;
    expect(config).toBe("sepang");
    const trees = buildFlora(track).flatMap((f) => f.instances);
    // Sepang measured 334 trees before the exclusion was added; the exclusion
    // must not cost more than a few percent of that.
    expect(trees.length).toBeGreaterThan(300);
  });
});

describe("circuits without a pit lane", () => {
  it("places no pit-lane keep-out and does not throw", () => {
    // Monaco has no lane (too short / too tight), so getPitLane returns null
    // and the keep-out must short-circuit rather than dereference it.
    const mono = TRACKS.find((t) => t.id === "monaco");
    expect(mono).toBeDefined();
    expect(() => buildFlora(getTrack("monaco"))).not.toThrow();
  });
});