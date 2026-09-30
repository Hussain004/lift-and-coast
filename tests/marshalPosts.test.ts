import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { barrierProfileForTrack } from "../lib/tracks/environment";
import { computeMarshalPosts, postShowsYellow, MARSHAL_SPACING_METERS } from "../lib/tracks/marshalPosts";

describe("marshal posts", () => {
  it("line every circuit behind the barrier, roughly one per spacing", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const posts = computeMarshalPosts(track);
      expect(posts.length, meta.id).toBeGreaterThan(track.lengthMeters / MARSHAL_SPACING_METERS / 2);
      expect(posts.length, meta.id).toBeLessThanOrEqual(Math.ceil(track.lengthMeters / MARSHAL_SPACING_METERS));
      const setback = barrierProfileForTrack(meta.id).setbackMeters;
      for (const post of posts) {
        let best = Infinity;
        let width = 12;
        track.centerline.forEach((c, i) => {
          const d = Math.hypot(c[0] - post.x, c[2] - post.z);
          if (d < best) {
            best = d;
            width = track.width[i] ?? 12;
          }
        });
        // Beyond the barrier's inside face, not on another stretch of road.
        expect(best, meta.id).toBeGreaterThan(width / 2 + setback);
        expect(Number.isFinite(post.yawRad)).toBe(true);
      }
    }
  });

  it("waves yellow on the stretch before an incident, across the start line too", () => {
    const lap = 5000;
    expect(postShowsYellow(1000, -1, lap)).toBe(false);
    expect(postShowsYellow(800, 1000, lap)).toBe(true);
    expect(postShowsYellow(1010, 1000, lap)).toBe(true);
    expect(postShowsYellow(1200, 1000, lap)).toBe(false);
    expect(postShowsYellow(300, 1000, lap)).toBe(false);
    expect(postShowsYellow(4800, 100, lap)).toBe(true);
  });
});
