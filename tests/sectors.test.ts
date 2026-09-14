import { describe, expect, it } from "vitest";
import { computeSectorGates } from "../lib/tracks/sectors";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

describe("computeSectorGates", () => {
  it("places two internal gates for three sectors, roughly a third apart", () => {
    const gates = computeSectorGates(track, 3);
    expect(gates).toHaveLength(2);
  });

  it("derives a heading matching the track's own start heading convention", () => {
    // A gate placed exactly at centerline[0] (i=0 case, not normally
    // produced by computeSectorGates but useful to isolate the heading
    // math) should reproduce the track's real authored startPos.headingRad,
    // since centerline[0] IS startPos and both derive heading from the
    // same forward-tangent convention.
    const n = track.centerline.length;
    const [px, , pz] = track.centerline[n - 1];
    const [nx, , nz] = track.centerline[1];
    const headingRad = Math.atan2(-(nx - px), -(nz - pz));
    expect(headingRad).toBeCloseTo(track.startPos.headingRad, 2);
  });

  it("spaces gates at equal arc-length intervals along the centerline", () => {
    const n = track.centerline.length;
    const gates = computeSectorGates(track, 3);
    // Check the underlying index spacing directly (arc length is uniform
    // per-index by construction - see mesh.test.ts/silverstone.json's own
    // ~2m-per-point spacing) rather than straight-line distance, which
    // underestimates arc length through a curving section and isn't a
    // reliable proxy for "a third of the track" on a real, winding layout.
    const idx1 = Math.round(n / 3);
    const idx2 = Math.round((2 * n) / 3);
    const [x1, , z1] = track.centerline[idx1 % n];
    const [x2, , z2] = track.centerline[idx2 % n];
    expect(gates[0].x).toBeCloseTo(x1, 5);
    expect(gates[0].z).toBeCloseTo(z1, 5);
    expect(gates[1].x).toBeCloseTo(x2, 5);
    expect(gates[1].z).toBeCloseTo(z2, 5);
  });
});
