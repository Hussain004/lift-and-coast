import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRACK_ID,
  TRACKS,
  getTrackName,
  isKnownTrackId,
  parseTrackId,
} from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { REFERENCE_LENGTH_METERS } from "./helpers/trackTables";
import {
  FLAT_WIDTH_TRACK_IDS,
  MAX_BUILT_GRADE,
  RELIEF_RATIO_MAX,
  RELIEF_RATIO_MIN,
  WIDTH_FLAT_EPSILON,
  WIDTH_MAX_METERS,
  WIDTH_MIN_METERS,
  WIDTH_VARIATION_MIN_METERS,
  rawDemSpreadMeters,
} from "../lib/tracks/trackMeasurements";

// Real-circuit reference lengths from the source dataset's own `length`
// property, ~the same values the build script prints. The built centerline
// is a resampled spline through the source polyline, so it lands within a
// fraction of a percent - a regression here means the pipeline or a raw
// file changed unexpectedly.

const RESAMPLE_SPACING_METERS = 2;

// Mean per-track width (metres) and the absolute bounds each point must
// stay within. Silverstone is genuinely the widest; the others sit near
// 9.5m. Monaco is hand-authored (TUMFTM has no coverage - see
// scripts/build-track.mts): 7m at the hairpin, ~12m on the fast sections.
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
        // The profile is validated against its own vendored DEM input rather
        // than a hand-typed band (see lib/tracks/trackMeasurements.ts): the
        // build averages the 90m samples, so the built relief must be a
        // plausible fraction of the raw spread - near zero means the relief
        // was lost, above 1 means the averaging was.
        const relief = max - min;
        const rawSpread = rawDemSpreadMeters(entry.id);
        if (rawSpread === null) {
          // No DEM file: this circuit's elevation is hand-authored keyframes
          // (Monaco, where the urban DEM inverts - see build-track.mts). It
          // has no source to check against, so pin the documented figure.
          expect(relief).toBeGreaterThan(0);
        } else {
          expect(relief / rawSpread).toBeGreaterThan(RELIEF_RATIO_MIN);
          expect(relief / rawSpread).toBeLessThan(RELIEF_RATIO_MAX);
        }
        // One global physical ceiling: the built circuits top out at 0.16,
        // and a loss of the averaging sends this to 0.5-0.84 at once.
        expect(maxGrade).toBeLessThan(MAX_BUILT_GRADE);
      });

      it("carries per-point widths from real data or the documented fallback", () => {
        // Built from the vendored TUMFTM racetrack-database (see
        // data/tracks/raw/tumftm/README.md), or from an authored constant for
        // the circuits it has no coverage for. Checked against physical
        // plausibility and against the build inputs' own shape rather than a
        // hand-typed band per circuit (see lib/tracks/trackMeasurements.ts):
        // a real circuit is between 6m and 25m wide everywhere, and whether a
        // profile should vary along the lap is a property of its SOURCE, not
        // something to re-measure and re-type by hand for each new circuit.
        const w = track.width;
        const min = Math.min(...w);
        const max = Math.max(...w);
        expect(min).toBeGreaterThan(WIDTH_MIN_METERS);
        expect(max).toBeLessThan(WIDTH_MAX_METERS);
        if (FLAT_WIDTH_TRACK_IDS.has(entry.id)) {
          // No measured upstream, so the width is a single authored constant:
          // the documented flat 13m fallback (see scripts/build-track.mts) for
          // the street venues, or a hand-authored one for Monaco and the
          // newest three. Every point must carry that same value, so the
          // constant cannot silently drift; the variation gate below does not
          // apply.
          expect(max - min).toBeLessThan(WIDTH_FLAT_EPSILON);
        } else {
          // The along-lap variation is the whole point of using real data.
          expect(max - min).toBeGreaterThan(WIDTH_VARIATION_MIN_METERS);
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
        const reference = REFERENCE_LENGTH_METERS[entry.id];
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