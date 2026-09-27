import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { FLAT_WIDTH_TRACK_IDS } from "../lib/tracks/trackMeasurements";
import { getTrack } from "../lib/tracks/trackData";
import {
  MAX_TERRAIN_DIP_METERS,
  MIN_DISTANCE_TRAVELED_METERS,
  MIN_TERRAIN_RELIEF,
  REGISTERED_TRACK_IDS,
  REQUIRED_PER_TRACK_TABLES,
} from "./helpers/trackTables";

/**
 * The completeness gate for per-track test tables.
 *
 * These tables index by track id, so a missing key is not a failure - it is
 * a silently weakened check. A circuit absent from MIN_DISTANCE_TRAVELED_
 * METERS still "passes" the AI stability gate; one absent from
 * MIN_TERRAIN_RELIEF quietly stops proving the field is not a plane. That
 * made adding a circuit mean hunting half a dozen tables across four files
 * and measuring each by hand, where missing one failed OPEN rather than
 * loud - the worst possible failure mode for a gate.
 *
 * So the tables live in tests/helpers/trackTables.ts and are checked here
 * against the registry in both directions: no circuit may be missing, and no
 * entry may outlive the circuit it was measured for.
 */
describe("per-track table completeness", () => {
  for (const { name, table } of REQUIRED_PER_TRACK_TABLES) {
    it(`${name} covers every registered circuit, and nothing else`, () => {
      const missing = TRACKS.filter((t) => !(t.id in table)).map((t) => t.id);
      const stale = Object.keys(table).filter((id) => !REGISTERED_TRACK_IDS.has(id));
      expect(missing, `${name} is missing circuits`).toEqual([]);
      expect(stale, `${name} has entries for unregistered circuits`).toEqual([]);
    });
  }

  it("FLAT_WIDTH_TRACK_IDS covers exactly the circuits whose widths are flat", () => {
    // Checked against the built data rather than trusted: a circuit added to
    // the list without an authored single-width profile would otherwise be
    // exempted from the along-lap variation gate for no reason.
    const actuallyFlat = TRACKS.filter((t) => {
      const w = getTrack(t.id).width;
      return Math.max(...w) - Math.min(...w) < 1e-6;
    }).map((t) => t.id);
    expect([...FLAT_WIDTH_TRACK_IDS].sort()).toEqual(actuallyFlat.sort());
  });

  it("every AI distance floor requires a meaningful fraction of a lap", () => {
    // A floor BELOW the lap length would let a car that never completes a lap
    // pass, which defeats the "never verify the AI with less than a full lap"
    // rule the table's own comment states. The rule is about the 180s RUN
    // covering more than a full lap (which the harness duration guarantees),
    // not about the pass/fail bar - so a slow circuit's floor may sit under
    // one lap. The floor must still be a real fraction of it, though: a bar
    // low enough to pass a car crawling in a circle is not a stability gate.
    for (const t of TRACKS) {
      const floor = MIN_DISTANCE_TRAVELED_METERS[t.id];
      const lap = getTrack(t.id).lengthMeters;
      expect(floor / lap, `${t.id} floor ${floor} vs lap ${lap}`).toBeGreaterThan(0.7);
      // ...and never above the fastest plausible pace for the circuit, which
      // would be a floor nothing could ever clear.
      expect(floor / lap, `${t.id} floor ${floor} vs lap ${lap}`).toBeLessThan(3);
    }
  });

  it("every terrain dip allowance is positive and finite", () => {
    for (const t of TRACKS) {
      const dip = MAX_TERRAIN_DIP_METERS[t.id];
      expect(Number.isFinite(dip), `${t.id} dip`).toBe(true);
      expect(dip, `${t.id} dip`).toBeGreaterThan(0);
    }
  });

  it("every terrain relief floor is positive", () => {
    for (const t of TRACKS) {
      const relief = MIN_TERRAIN_RELIEF[t.id];
      expect(relief, `${t.id} relief`).toBeGreaterThan(0);
    }
  });
});
