/**
 * Per-track facts derived from the vendored SOURCE data rather than typed
 * into a test table.
 *
 * Adding a circuit used to mean finding and editing five separate
 * `Record<string, ...>` tables across four test files, each measured by
 * hand. Miss one and the new track is silently unverified (every one of
 * those tables indexes by track id, so a missing key reads as `undefined`
 * and quietly weakens or skips the check). The numbers themselves are
 * already in the repo as build inputs: the circuit's real length lives in
 * the raw centerline GeoJSON's `length` property, and its elevation comes
 * from the raw DEM sample file. Comparing the BUILT track against those
 * inputs is a stronger check than a hand-typed band - it cannot drift from
 * the thing it is validating - and it needs no maintenance at all.
 */

/** Raw DEM sample file shape (see scripts/fetch-elevation.mts). */
interface RawElevationFile {
  id: string;
  coordinates: [number, number][];
  elevationMeters: number[];
}

/**
 * The built lap's relief (max y - min y) as a fraction of the raw DEM
 * spread it was baked from.
 *
 * The build averages each DEM sample over a wide disc before using it (see
 * the averaging constants in scripts/build-track.mts), which necessarily
 * compresses the result: the raw 90m-resolution samples step around
 * between neighbouring cells, and averaging that is what turns a staircase
 * into a drivable profile. Measured across all 28 DEM-built circuits the
 * ratio lands between 0.38 and 0.92, so the band below has real margin at
 * both ends and is not tuned to any single circuit.
 *
 * Both ends of the band matter, and they are the two failures the old
 * hand-typed table existed to catch: a ratio near zero means the profile
 * lost its relief (the field was replaced by a plane), and a ratio above 1
 * means the averaging was lost and the raw 50-84% DEM staircase is back.
 */
export const RELIEF_RATIO_MIN = 0.25;
export const RELIEF_RATIO_MAX = 1.0;

/**
 * Steepest gradient the built profile may contain, as a fraction.
 *
 * One global physical ceiling rather than a per-track number: the built
 * circuits top out at 0.16 (Spa), and a loss of the DEM averaging sends
 * this to 0.5-0.84 immediately, so the exact per-track value was never
 * doing the work - the band between "smoothed" and "staircase" is enormous.
 */
export const MAX_BUILT_GRADE = 0.2;

/**
 * Physical plausibility for track width, meters. The real circuits' measured
 * widths (TUMFTM) and the authored profiles for the uncovered ones both sit
 * inside this, while the old flat 13m placeholder and a broken centerline
 * alignment do not produce something outside it.
 *
 * The built extremes are Monaco's 7.0m hairpin at the narrow end and COTA's
 * 27.3m at the wide end, so these carry about a metre of margin each side
 * rather than clipping a real circuit.
 */
export const WIDTH_MIN_METERS = 6;
export const WIDTH_MAX_METERS = 28;

/**
 * Minimum along-lap width variation for a track whose widths came from real
 * measured data. A genuinely varying profile varies by more than this; the
 * flat authored/fallback ones are checked for exact flatness instead.
 */
export const WIDTH_VARIATION_MIN_METERS = 1.5;

/**
 * Tolerance for "exactly flat". The authored and fallback widths are single
 * constants written into every point, so they should be bit-identical; this
 * only absorbs float storage through JSON.
 */
export const WIDTH_FLAT_EPSILON = 1e-6;

/**
 * Every circuit whose width is a single authored constant or the documented
 * fallback, rather than measured per-point data. These must be EXACTLY flat
 * (so the constant cannot silently drift); everything else must show real
 * along-lap variation, which is the whole point of using measured data.
 *
 * Derived from the build inputs rather than hand-listed: a track has a flat
 * width profile exactly when it has no TUMFTM coverage AND a single authored
 * width. See scripts/build-track.mts - the circuits below are the ones with
 * `widthFile: null` that do not also carry a multi-segment `manualWidths`
 * table. Monaco is deliberately NOT here: TUMFTM has no coverage for it
 * either, but its authored profile is a 13-segment range table (7m at the
 * hairpin, 12m on the fast sections), so it genuinely varies along the lap
 * and belongs under the variation gate.
 */
export const FLAT_WIDTH_TRACK_IDS: ReadonlySet<string> = new Set([
  // widthFile: null, flat 13m fallback.
  "miami", "madrid", "baku", "singapore", "lasvegas", "lusail",
  // widthFile: null, hand-authored single-width profile.
  "jeddah", "imola", "istanbul",
]);

/** Raw DEM sample spread for a circuit, meters, or null if hand-authored. */
export function rawDemSpreadMeters(trackId: string): number | null {
  const file = rawElevationFile(trackId);
  if (file === null) return null;
  const values = file.elevationMeters;
  if (!Array.isArray(values) || values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) return null;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return max - min;
}

/** True when this circuit's elevation is hand-authored rather than DEM-baked. */
export function elevationIsHandAuthored(trackId: string): boolean {
  return rawElevationFile(trackId) === null;
}

function rawElevationFile(trackId: string): RawElevationFile | null {
  // Vite/Next inline these as modules so the test suite gets the same files
  // the build read, with no filesystem access and no drift between them.
  const modules = import.meta.glob("../../data/tracks/raw/elevation/*.json", {
    eager: true,
    import: "default",
  }) as Record<string, RawElevationFile>;
  for (const [path, file] of Object.entries(modules)) {
    if (path.endsWith(`/${trackId}.json`)) return file;
  }
  return null;
}
