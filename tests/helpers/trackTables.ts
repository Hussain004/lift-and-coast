/**
 * Per-track overrides that must exist for EVERY registered circuit.
 *
 * These are the tables that index by track id, where a missing key is not an
 * error but a silently weakened check: a new circuit that is absent from
 * MIN_DISTANCE_TRAVELED_METERS still "passes" the AI stability gate, and one
 * absent from MIN_TERRAIN_RELIEF quietly stops proving the field is not a
 * plane. Adding a circuit therefore meant finding and editing half a dozen
 * `Record<string, ...>` tables scattered across four test files, measured by
 * hand - and missing one failed open, not loud.
 *
 * They live here, in one place, so tests/perTrackTables.test.ts can assert
 * the set is complete against the registry. Where a bound can be DERIVED from
 * the build inputs instead of measured by hand, it is derived - see
 * lib/tracks/trackMeasurements.ts, which took the width and elevation band
 * tables out of existence entirely.
 */
import { TRACKS } from "../../lib/tracks/registry";

/**
 * Distance floor: a stuck, spun or stopped car fails this by a wide margin,
 * while normal pace clears it easily. Per-track, because pace is set by the
 * downforce-aware speed profile (see racingLine.ts): Monaco's 3333m lap is
 * mostly slow corners where the honest target averages ~30 m/s, so no
 * controller can average the 33 m/s a single global floor demands there -
 * the floor below still requires MORE than one full Monaco lap (3500 >
 * 3333, observed ~4200) while the flowing circuits keep the ~33 m/s bar
 * (observed 6300-7400). Same logic for the scale-out circuits, measured
 * with the same harness: Spielberg is short and fast (5000 over a 4311m
 * lap), Bahrain's traction zones pace it at ~33 m/s (5300 over 5431m),
 * COTA has the slowest profile of the set at ~38 m/s target average (4000
 * still separates a stalled car several times over), Zandvoort's dunes at
 * ~40 (4500 over 4268m). Second scale-out batch, same method: Budapest
 * 4500, Melbourne 5000, Montreal 4500, Mexico 4500, Shanghai 5000,
 * Interlagos 5000 (1.16 laps, observed 6202), Yas Marina 4500 (observed
 * 5791). Third batch, same method: Hockenheim 5000 (1.1 laps, observed
 * 5620), Sepang, Sochi and the Nürburgring 4500 each (observed
 * 5649/5642/5407). Fourth batch (2026 additions): Miami 5500 (1.1 laps,
 * observed 5963), Barcelona 6000 (observed 6337), Madrid 4500 (0.9 laps
 * in 180s), Baku 5000 (observed 5776), Singapore 4000 (observed 4655),
 * Las Vegas 5500 (observed 6498), Lusail 5000 (observed 6125). Fifth
 * batch: Jeddah 5700 (observed 6609), Imola 5700 (observed 6208),
 * Istanbul 5000 (observed 5656).
 */
export const MIN_DISTANCE_TRAVELED_METERS: Record<string, number> = {
  silverstone: 6000,
  monza: 6000,
  spa: 6000,
  suzuka: 6000,
  monaco: 3500,
  spielberg: 5000,
  bahrain: 5300,
  cota: 4000,
  zandvoort: 4500,
  budapest: 4500,
  melbourne: 5000,
  montreal: 4500,
  mexico: 4500,
  shanghai: 5000,
  interlagos: 5000,
  yasmarina: 4500,
  hockenheim: 5000,
  sepang: 4500,
  sochi: 4500,
  nurburgring: 4500,
  miami: 5500,
  barcelona: 6000,
  madrid: 4500,
  baku: 5000,
  singapore: 4000,
  lasvegas: 5500,
  lusail: 5000,
  jeddah: 5700,
  imola: 5700,
  istanbul: 5000,
};

/**
 * Relief the terrain field has to reproduce at all: the ground follows the
 * circuit, so it is never flat. Loose on purpose - it is here to catch "the
 * field was replaced by a plane again", not to re-measure the profile (the
 * measured version of that is tests/trackRegistry.test.ts, which checks the
 * built relief against the vendored DEM rather than a hand-typed number).
 */
export const MIN_TERRAIN_RELIEF: Record<string, number> = {
  silverstone: 5,
  monza: 10,
  spa: 50,
  suzuka: 20,
  monaco: 20,
  spielberg: 40,
  bahrain: 5,
  cota: 10,
  zandvoort: 2,
  budapest: 18,
  melbourne: 3,
  montreal: 5,
  mexico: 2,
  shanghai: 2,
  interlagos: 22,
  yasmarina: 5,
  hockenheim: 10,
  sepang: 18,
  sochi: 3,
  nurburgring: 40,
  miami: 3,
  barcelona: 15,
  madrid: 10,
  baku: 20,
  singapore: 6,
  lasvegas: 12,
  lusail: 2,
  jeddah: 2,
  imola: 28,
  istanbul: 28,
};

/**
 * How far the field may dip under the ribbon at an edge sample. The
 * clearance pass pushes overlapping terrain until it clears the asphalt, and
 * at Monaco the lap's arms genuinely differ in height inside one 12.5m cell
 * (the climb, the hairpin fold) - that difference has to go somewhere, and
 * below the ribbon, as a grass bank beside the track, is the side that hides
 * no asphalt. Zandvoort's banked T3 gets the same treatment one step
 * further: 19 degrees of cross-slope is a ~1.4m height difference across the
 * asphalt inside a single 12.5m cell, and no plane the cell's triangle can
 * take is both below the tilted ribbon and at the edge's height - the
 * boundary samples interpolate the embankment under the road with the
 * shoulder beside it and read low by up to ~1.8m at isolated grid-phase
 * spots. The road itself is verified clear (the road-sampling test above
 * samples every ribbon triangle densely), the per-sample average below is
 * unchanged, and the AI gate drives the corner for real - so the allowance
 * is per-track, like Monaco's, not a loosened global.
 */
export const MAX_TERRAIN_DIP_METERS: Record<string, number> = {
  silverstone: 0.5,
  monza: 0.5,
  spa: 0.5,
  suzuka: 0.5,
  monaco: 0.75,
  spielberg: 0.5,
  bahrain: 0.5,
  cota: 0.5,
  zandvoort: 2.0,
  budapest: 0.5,
  melbourne: 0.5,
  montreal: 0.5,
  mexico: 0.5,
  shanghai: 0.5,
  interlagos: 0.5,
  yasmarina: 0.5,
  hockenheim: 0.5,
  sepang: 0.5,
  sochi: 0.5,
  nurburgring: 0.5,
  miami: 0.5,
  barcelona: 0.5,
  // T12's 13.5-degree La Monumental bank is the steepest cross-slope in
  // the set; the coarse terrain cells can bridge its ~1.1m edge apron.
  madrid: 1.5,
  baku: 0.5,
  singapore: 0.5,
  lasvegas: 0.5,
  lusail: 0.5,
  jeddah: 0.5,
  imola: 0.5,
  istanbul: 0.5,
};

/**
 * Real-circuit reference lengths from the source dataset's own `length`
 * property (data/tracks/raw/*.geojson), ~the same values the build script
 * prints. The built centerline must land within 3% of the circuit's real
 * length, which is a real check on the resample/spline pipeline and not just
 * a self-consistency one.
 */
export const REFERENCE_LENGTH_METERS: Record<string, number> = {
  silverstone: 5891,
  spa: 7004,
  monza: 5793,
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
  miami: 5412,
  barcelona: 4655,
  madrid: 5474,
  baku: 6003,
  singapore: 4928,
  lasvegas: 6201,
  lusail: 5380,
  jeddah: 6175,
  imola: 4909,
  istanbul: 5338,
};

/** Every table above must have an entry for every registered circuit. */
export const REQUIRED_PER_TRACK_TABLES: ReadonlyArray<{
  name: string;
  table: Record<string, unknown>;
}> = [
  { name: "MIN_DISTANCE_TRAVELED_METERS", table: MIN_DISTANCE_TRAVELED_METERS },
  { name: "MIN_TERRAIN_RELIEF", table: MIN_TERRAIN_RELIEF },
  { name: "MAX_TERRAIN_DIP_METERS", table: MAX_TERRAIN_DIP_METERS },
  { name: "REFERENCE_LENGTH_METERS", table: REFERENCE_LENGTH_METERS },
];

export const REGISTERED_TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));
