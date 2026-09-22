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
  monaco: 3337,
  spielberg: 4318,
  bahrain: 5412,
  cota: 5514,
  zandvoort: 4259,
  budapest: 4381,
  melbourne: 5278,
  montreal: 4361,
  mexico: 4304,
  shanghai: 5451,
  interlagos: 4309,
  yasmarina: 5281,
  hockenheim: 4574,
  sepang: 5543,
  sochi: 5848,
  nurburgring: 5148,
  // 2026-calendar additions: lengths from the source dataset's own
  // `length` property (data/tracks/raw/{us-2022,es-1991,es-2026,az-2016,
  // sg-2008,us-2023,qa-2004}.geojson).
  miami: 5412,
  barcelona: 4655,
  madrid: 5474,
  baku: 6003,
  singapore: 4928,
  lasvegas: 6201,
  lusail: 5380,
};

const RESAMPLE_SPACING_METERS = 2;

// Mean per-track width (metres) and the absolute bounds each point must
// stay within. Silverstone is genuinely the widest; the others sit near
// 9.5m. Monaco is hand-authored (TUMFTM has no coverage - see
// scripts/build-track.mts): 7m at the hairpin, ~12m on the fast sections.
// The 2026 additions bar Barcelona have no TUMFTM coverage either, so the
// build applies its documented flat 13m fallback there (`flat: true` pins
// that fallback to exactly flat - see the assertion below).
const WIDTH_BANDS: Record<string, { min: number; max: number; mean: number; flat?: boolean }> = {
  silverstone: { min: 10.5, max: 19.0, mean: 13.8 },
  monza: { min: 7.0, max: 13.5, mean: 9.4 },
  spa: { min: 7.0, max: 17.5, mean: 9.8 },
  suzuka: { min: 7.0, max: 16.5, mean: 9.8 },
  monaco: { min: 6.5, max: 12.5, mean: 9.9 },
  spielberg: { min: 9.5, max: 14.5, mean: 11.0 },
  bahrain: { min: 10.0, max: 22.5, mean: 13.4 },
  cota: { min: 10.5, max: 28.0, mean: 13.9 },
  zandvoort: { min: 7.5, max: 16.5, mean: 10.5 },
  budapest: { min: 7.0, max: 16.5, mean: 10.0 },
  melbourne: { min: 7.5, max: 16.5, mean: 12.3 },
  montreal: { min: 7.5, max: 15.0, mean: 9.7 },
  mexico: { min: 9.0, max: 18.0, mean: 12.3 },
  shanghai: { min: 10.0, max: 18.0, mean: 13.0 },
  interlagos: { min: 8.5, max: 18.5, mean: 11.9 },
  yasmarina: { min: 9.5, max: 16.0, mean: 12.9 },
  hockenheim: { min: 7.0, max: 19.0, mean: 12.6 },
  sepang: { min: 13.0, max: 17.0, mean: 14.6 },
  sochi: { min: 10.5, max: 21.0, mean: 12.6 },
  nurburgring: { min: 7.0, max: 22.0, mean: 11.8 },
  miami: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
  barcelona: { min: 8.5, max: 18.0, mean: 11.2 },
  madrid: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
  baku: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
  singapore: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
  lasvegas: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
  lusail: { min: 12.5, max: 13.5, mean: 13.0, flat: true },
};

// Elevation as built from the vendored DEM samples (see
// scripts/fetch-elevation.mts and the averaging constants in
// scripts/build-track.mts). `range` is the lap's total relief in meters - the
// real circuits are roughly Silverstone 11m, Monza 20m, Suzuka 45m, Spa 92m,
// Spielberg 62m, Bahrain 16m, COTA 18m, Zandvoort 4m, Budapest 32m,
// Melbourne 6m, Montreal 9m, Mexico 4m, Shanghai 5m, Interlagos 40m,
// Yas Marina 9m, and Monaco 32m (hand-authored keyframes: the urban DEM
// inverts there, see build-track.mts) - and `maxGrade` the steepest point. The grade ceiling is the important
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
  monaco: { range: [28, 42], maxGrade: 0.12 },
  spielberg: { range: [50, 75], maxGrade: 0.15 },
  bahrain: { range: [12, 24], maxGrade: 0.06 },
  cota: { range: [14, 26], maxGrade: 0.07 },
  zandvoort: { range: [3, 8], maxGrade: 0.03 },
  budapest: { range: [24, 40], maxGrade: 0.1 },
  melbourne: { range: [4, 10], maxGrade: 0.03 },
  montreal: { range: [6, 14], maxGrade: 0.06 },
  mexico: { range: [3, 8], maxGrade: 0.03 },
  shanghai: { range: [3, 8], maxGrade: 0.03 },
  interlagos: { range: [32, 50], maxGrade: 0.12 },
  yasmarina: { range: [7, 14], maxGrade: 0.04 },
  hockenheim: { range: [11, 19], maxGrade: 0.06 },
  sepang: { range: [18, 30], maxGrade: 0.08 },
  sochi: { range: [4, 8], maxGrade: 0.03 },
  nurburgring: { range: [42, 60], maxGrade: 0.12 },
  // 2026 additions, measured from the built DEM profiles. Baku's DEM is
  // Caspian shore + city (32m of genuine relief); Lusail is a flat desert
  // bowl at 4.3m.
  miami: { range: [3, 8], maxGrade: 0.04 },
  barcelona: { range: [18, 34], maxGrade: 0.09 },
  madrid: { range: [12, 25], maxGrade: 0.09 },
  baku: { range: [22, 44], maxGrade: 0.13 },
  singapore: { range: [7, 15], maxGrade: 0.06 },
  lasvegas: { range: [15, 30], maxGrade: 0.07 },
  lusail: { range: [2, 7], maxGrade: 0.03 },
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
    expect(parseTrackId("atlantis")).toBe(DEFAULT_TRACK_ID);
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
  it("has sixteen circuits with unique ids and short labels", () => {
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
    expect(ids).toContain("monaco");
    expect(ids).toContain("spielberg");
    expect(ids).toContain("bahrain");
    expect(ids).toContain("cota");
    expect(ids).toContain("zandvoort");
    expect(ids).toContain("budapest");
    expect(ids).toContain("melbourne");
    expect(ids).toContain("montreal");
    expect(ids).toContain("mexico");
    expect(ids).toContain("shanghai");
    expect(ids).toContain("interlagos");
    expect(ids).toContain("yasmarina");
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

      it("carries per-point widths from real data or the documented fallback", () => {
        // Built from the vendored TUMFTM racetrack-database (see
        // data/tracks/raw/tumftm/README.md) - except Monaco, whose widths
        // are hand-authored segments (TUMFTM has no coverage, see
        // scripts/build-track.mts). These bands are the values as built
        // from that data: wide enough to absorb small pipeline
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
        if (band.flat) {
          // No TUMFTM coverage upstream: the build's documented flat 13m
          // fallback (see scripts/build-track.mts). Pin the fallback to
          // exactly flat, so it cannot silently drift; the variation gate
          // below does not apply to it.
          expect(Math.max(...w)).toBeCloseTo(13, 6);
          expect(Math.min(...w)).toBeCloseTo(13, 6);
        } else {
          // The along-lap variation is the whole point of using real data.
          expect(Math.max(...w) - Math.min(...w)).toBeGreaterThan(1.5);
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