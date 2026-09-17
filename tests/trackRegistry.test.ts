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

// Mean per-track width (metres) and the absolute bounds each point must
// stay within, as built from the vendored TUMFTM width files. Silverstone
// is genuinely the widest of the four; the others sit near 9.5m.
const WIDTH_BANDS: Record<string, { min: number; max: number; mean: number }> = {
  silverstone: { min: 10.5, max: 19.0, mean: 13.8 },
  monza: { min: 7.0, max: 13.5, mean: 9.4 },
  spa: { min: 7.0, max: 17.5, mean: 9.8 },
  suzuka: { min: 7.0, max: 16.5, mean: 9.8 },
};

// Elevation as built from the vendored DEM samples (see
// scripts/fetch-elevation.mts and the averaging constants in
// scripts/build-track.mts). `range` is the lap's total relief in meters - the
// real circuits are roughly Silverstone 11m, Monza 20m, Suzuka 45m and Spa
// 92m - and `maxGrade` the steepest point. The grade ceiling is the important
// one: the raw DEM samples produce 50-84% grades and step 30m between
// neighbouring 90m cells, so a regression in the averaging shows up here as a
// spike rather than as a subtly wrong lap. The bands are the built values with
// room around them, so a tweak to the averaging radius passes but a profile
// that has lost its smoothing (or its relief) does not.
const ELEVATION_BANDS: Record<
  string,
  { range: [number, number]; maxGrade: number }
> = {
  silverstone: { range: [8, 16], maxGrade: 0.04 },
  monza: { range: [14, 28], maxGrade: 0.07 },
  spa: { range: [80, 120], maxGrade: 0.16 },
  suzuka: { range: [36, 56], maxGrade: 0.1 },
};

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

      it("has one width per centerline point", () => {
        expect(track.width.length).toBe(track.centerline.length);
      });

      it("carries real elevation, normalized to the start line", () => {
        // The profile is baked from vendored DEM samples and normalized so
        // startPos sits at y=0 - which is what lets spawn/reset/camera code
        // use a track-relative floor (see scripts/build-track.mts).
        expect(track.centerline[0][1]).toBeCloseTo(0, 6);
        const band = ELEVATION_BANDS[entry.id];
        expect(band).toBeDefined();

        let min = Infinity;
        let max = -Infinity;
        let maxGrade = 0;
        const line = track.centerline;
        for (let i = 0; i < line.length; i++) {
          const a = line[i];
          const b = line[(i + 1) % line.length];
          min = Math.min(min, a[1]);
          max = Math.max(max, a[1]);
          const run = Math.hypot(b[0] - a[0], b[2] - a[2]);
          if (run > 0) maxGrade = Math.max(maxGrade, Math.abs(b[1] - a[1]) / run);
        }
        expect(max - min).toBeGreaterThan(band.range[0]);
        expect(max - min).toBeLessThan(band.range[1]);
        expect(maxGrade).toBeLessThan(band.maxGrade);
      });

      it("carries real per-point widths, not a flat placeholder", () => {
        // Built from the vendored TUMFTM racetrack-database (see
        // data/tracks/raw/tumftm/README.md). These bands are the values as
        // built from that data: wide enough to absorb small pipeline
        // changes, tight enough to catch a regression to the old flat 13m
        // placeholder or a broken centerline alignment.
        const band = WIDTH_BANDS[entry.id];
        expect(band).toBeDefined();
        const w = track.width;
        let sum = 0;
        for (const value of w) {
          expect(value).toBeGreaterThan(band.min);
          expect(value).toBeLessThan(band.max);
          sum += value;
        }
        expect(Math.abs(sum / w.length - band.mean)).toBeLessThan(0.5);
        // The along-lap variation is the whole point of using real data.
        expect(Math.max(...w) - Math.min(...w)).toBeGreaterThan(1.5);
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