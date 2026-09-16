import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACK_ID,
  TRACKS,
  getTrackName,
  isKnownTrackId,
  parseTrackId,
} from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";

// Real-circuit reference lengths from the source dataset's own `length`
// property, ~the same values the build script prints. The built centerline
// is a resampled spline through the source polyline, so it lands within a
// fraction of a percent - a regression here means the pipeline or a raw
// file changed unexpectedly.
const REFERENCE_LENGTHS: Record<string, number> = {
  silverstone: 5891,
  monza: 5793,
  spa: 7004,
  suzuka: 5807,
};

const RESAMPLE_SPACING_METERS = 2;

describe("parseTrackId", () => {
  it("accepts every known id", () => {
    for (const entry of TRACKS) {
      expect(parseTrackId(entry.id)).toBe(entry.id);
    }
  });

  it("falls back to the default for unknown and missing values", () => {
    expect(parseTrackId(null)).toBe(DEFAULT_TRACK_ID);
    expect(parseTrackId("")).toBe(DEFAULT_TRACK_ID);
    expect(parseTrackId("nurburgring")).toBe(DEFAULT_TRACK_ID);
    expect(parseTrackId("SILVERSTONE")).toBe(DEFAULT_TRACK_ID); // case-sensitive on purpose
  });
});

describe("getTrackName / isKnownTrackId", () => {
  it("resolves each known id to its own name", () => {
    for (const entry of TRACKS) {
      expect(getTrackName(entry.id)).toBe(entry.name);
    }
  });

  it("falls back to the default track for an unknown id", () => {
    expect(getTrackName("nowhere")).toBe(TRACKS[0].name);
  });

  it("knows exactly the registered ids", () => {
    expect(isKnownTrackId("spa")).toBe(true);
    expect(isKnownTrackId("spa-2007")).toBe(false);
  });
});

describe("registry contents", () => {
  it("has four circuits with unique ids and short labels", () => {
    expect(TRACKS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(TRACKS.map((t) => t.id)).size).toBe(TRACKS.length);
    for (const entry of TRACKS) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.shortName.length).toBeGreaterThan(0);
    }
  });

  it("includes the Phase 4 scale-out circuits", () => {
    const ids = TRACKS.map((t) => t.id);
    expect(ids).toContain("silverstone");
    expect(ids).toContain("monza");
    expect(ids).toContain("spa");
    expect(ids).toContain("suzuka");
  });
});

describe("getTrack (geometry loader)", () => {
  it("resolves each known id to geometry carrying its own id", () => {
    for (const entry of TRACKS) {
      const track = getTrack(entry.id);
      expect(track.id).toBe(entry.id);
      expect(track.lengthMeters).toBeGreaterThan(1000);
    }
  });

  it("falls back to the default track's geometry for an unknown id", () => {
    expect(getTrack("nowhere").id).toBe(DEFAULT_TRACK_ID);
  });
});

describe("built track data integrity", () => {
  for (const entry of TRACKS) {
    describe(entry.id, () => {
      const track = getTrack(entry.id);

      it("has one width per centerline point, all flat at y=0", () => {
        expect(track.width.length).toBe(track.centerline.length);
        for (const [, y] of track.centerline) {
          expect(y).toBe(0);
        }
      });

      it("is resampled at a uniform ~2m spacing", () => {
        const n = track.centerline.length;
        // Every interior segment is exactly one arc-length step (2m); its
        // chord is fractionally shorter through a corner but never far off
        // (tightest observed ~1.99m).
        for (let i = 0; i < n - 1; i++) {
          const [ax, , az] = track.centerline[i];
          const [bx, , bz] = track.centerline[i + 1];
          const d = Math.hypot(bx - ax, bz - az);
          expect(d).toBeGreaterThan(RESAMPLE_SPACING_METERS * 0.95);
          expect(d).toBeLessThan(RESAMPLE_SPACING_METERS * 1.01);
        }
        // The closing (last -> first) segment is the leftover arc-length
        // remainder, so it is the one segment allowed to be shorter than a
        // full step (down to just above zero).
        const [fx, , fz] = track.centerline[0];
        const [lx, , lz] = track.centerline[n - 1];
        const closure = Math.hypot(fx - lx, fz - lz);
        expect(closure).toBeGreaterThan(0);
        expect(closure).toBeLessThanOrEqual(RESAMPLE_SPACING_METERS * 1.01);
      });

      it("matches the source circuit's reference length within 3%", () => {
        const reference = REFERENCE_LENGTHS[entry.id];
        expect(reference).toBeDefined();
        expect(Math.abs(track.lengthMeters - reference) / reference).toBeLessThan(0.03);
      });

      it("spawns the start position on the centerline", () => {
        const { startPos } = track;
        const nearest = Math.min(
          ...track.centerline.map(([x, , z]) => Math.hypot(x - startPos.x, z - startPos.z))
        );
        expect(nearest).toBeLessThan(RESAMPLE_SPACING_METERS * 2);
      });
    });
  }
});