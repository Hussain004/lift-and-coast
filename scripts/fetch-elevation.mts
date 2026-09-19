/**
 * One-off data fetcher (plan section 4): samples a public elevation API
 * along each circuit's centerline and vendors the result, so the track
 * build stays offline and deterministic (the same pattern as the vendored
 * TUMFTM width files).
 *
 * Run with: node --experimental-strip-types scripts/fetch-elevation.mts
 *
 * Source is Open-Meteo's `/v1/elevation` endpoint, which serves Copernicus
 * DEM GLO-90 (roughly 90 m per sample). That is far coarser than the track:
 * it reports the terrain around the circuit, not the asphalt's own grade, so
 * the build script averages it over a wide disc before using it. Good for the
 * broad shape (Spa's 100 m drop, Suzuka's esses); not a substitute for
 * surveyed height keyframes.
 *
 * The sample points are a fixed arc-length densification of the raw polyline
 * rather than the raw vertices themselves: those vertices are up to 377m
 * apart on the coarser circuits (Spa), which would leave whole straights with
 * no sample anywhere near them - the averaging disc in build-track.mts would
 * then have nothing to average and the profile would step tens of meters
 * between one distant sample and the next.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENDPOINT = "https://api.open-meteo.com/v1/elevation";
const SOURCE = "Open-Meteo /v1/elevation (Copernicus DEM GLO-90)";
const MAX_COORDS_PER_REQUEST = 100;
const REQUEST_PAUSE_MS = 2000;
// The endpoint rate-limits, so a chunk is retried with a growing pause
// instead of failing the whole run.
const MAX_ATTEMPTS = 6;
const RETRY_BASE_MS = 5000;
// Fixed spacing of the vendored samples along the lap, in meters. The DEM
// itself is ~90m per sample, so this only has to be dense enough to give the
// averaging disc something to work with everywhere along the track.
const SAMPLE_SPACING_METERS = 25;

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = `${scriptDir}/../data/tracks/raw/elevation`;

const TRACKS: { id: string; rawFile: string }[] = [
  { id: "silverstone", rawFile: "gb-1948.geojson" },
  { id: "spa", rawFile: "be-1925.geojson" },
  { id: "monza", rawFile: "it-1922.geojson" },
  { id: "suzuka", rawFile: "jp-1962.geojson" },
  { id: "spielberg", rawFile: "at-1969.geojson" },
  { id: "bahrain", rawFile: "bh-2002.geojson" },
  { id: "cota", rawFile: "us-2012.geojson" },
  { id: "zandvoort", rawFile: "nl-1948.geojson" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Walk the closed polyline at a fixed spacing, interpolating lon/lat. The
 * chord lengths are measured in an equirectangular approximation about the
 * circuit's own latitude, which is the same projection the build script uses
 * (`lonLatToMeters`), so the densified points land on the same path.
 */
function densify(coords: [number, number][], spacing: number): [number, number][] {
  const lat0 = coords.reduce((sum, c) => sum + c[1], 0) / coords.length;
  const metersPerLat = 111320;
  const metersPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const n = coords.length;
  const cumulative: number[] = [0];
  for (let i = 1; i <= n; i++) {
    const a = coords[i - 1];
    const b = coords[i % n];
    cumulative.push(
      cumulative[i - 1] +
        Math.hypot((b[0] - a[0]) * metersPerLon, (b[1] - a[1]) * metersPerLat)
    );
  }
  const out: [number, number][] = [];
  let segment = 0;
  for (let d = 0; d < cumulative[n]; d += spacing) {
    while (cumulative[segment + 1] < d) segment++;
    const segStart = cumulative[segment];
    const segEnd = cumulative[segment + 1];
    const a = coords[segment % n];
    const b = coords[(segment + 1) % n];
    const u = segEnd === segStart ? 0 : (d - segStart) / (segEnd - segStart);
    out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
  }
  return out;
}

async function fetchChunk(coords: [number, number][]): Promise<number[]> {
  const url =
    `${ENDPOINT}?latitude=` +
    coords.map((c) => c[1].toFixed(5)).join(",") +
    "&longitude=" +
    coords.map((c) => c[0].toFixed(5)).join(",");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const json = (await res.json()) as { elevation?: number[] };
      if (!Array.isArray(json.elevation)) {
        throw new Error(`unexpected response: ${JSON.stringify(json).slice(0, 200)}`);
      }
      return json.elevation;
    }
    if (res.status !== 429 || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${res.status} ${res.statusText} for ${url}`);
    }
    const wait = RETRY_BASE_MS * attempt;
    console.log(`  429, retrying in ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await sleep(wait);
  }
}

mkdirSync(OUT_DIR, { recursive: true });

for (const { id, rawFile } of TRACKS) {
  const geo = JSON.parse(readFileSync(`${scriptDir}/../data/tracks/raw/${rawFile}`, "utf-8"));
  const rawCoords: [number, number][] = geo.features[0].geometry.coordinates;
  const coords = densify(rawCoords, SAMPLE_SPACING_METERS);

  const elevationMeters: number[] = [];
  for (let i = 0; i < coords.length; i += MAX_COORDS_PER_REQUEST) {
    const chunk = coords.slice(i, i + MAX_COORDS_PER_REQUEST);
    elevationMeters.push(...(await fetchChunk(chunk)));
    if (i + MAX_COORDS_PER_REQUEST < coords.length) await sleep(REQUEST_PAUSE_MS);
  }
  if (elevationMeters.length !== coords.length) {
    throw new Error(`${id}: got ${elevationMeters.length} for ${coords.length} coords`);
  }

  const payload = {
    id,
    source: SOURCE,
    rawFile,
    fetchedAt: new Date().toISOString().slice(0, 10),
    note: `Coordinates are the raw polyline walked at ${SAMPLE_SPACING_METERS}m spacing; one elevation per coordinate, same order.`,
    coordinates: coords.map((c) => [Number(c[0].toFixed(6)), Number(c[1].toFixed(6))]),
    elevationMeters,
  };
  writeFileSync(`${OUT_DIR}/${id}.json`, JSON.stringify(payload));
  const min = Math.min(...elevationMeters);
  const max = Math.max(...elevationMeters);
  console.log(`${id}: ${elevationMeters.length} samples every ${SAMPLE_SPACING_METERS}m, ${min}-${max}m`);
}
