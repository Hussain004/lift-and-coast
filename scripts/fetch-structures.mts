/**
 * One-off data fetcher (plan section 4, trackside detail): pulls mapped
 * trackside structures around each circuit from the OpenStreetMap API and
 * vendors the filtered result, so the track build stays offline and
 * deterministic (the same pattern as the vendored TUMFTM width files and
 * scripts/fetch-elevation.mts).
 *
 * Run with: node --experimental-strip-types scripts/fetch-structures.mts
 *
 * Source is the OSM /api/0.6/map bbox endpoint (bulk read, no Overpass
 * needed): one call per circuit covers the whole lap, since even Spa fits
 * in a fraction of the endpoint's area limit. Kept features are buildings
 * (grandstands carry building=grandstand explicitly), barriers near the
 * track, tunnels, and amusement rides - everything else (roads, landuse,
 * parking, trees) is dropped at fetch time. Rings are simplified to ~1.5m
 * and rounded; positions stay lon/lat so the file remains human-checkable
 * against real maps, and lib/tracks/structures.ts projects them with the
 * same formula scripts/build-track.mts uses.
 *
 * Etiquette: sequential calls with a pause between them, tiny total volume.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = `${scriptDir}/../data/tracks/structures`;
const RAW_DIR = `${scriptDir}/../data/tracks/raw`;

const TRACKS: { id: string; rawFile: string; padMeters: number }[] = [
  { id: "silverstone", rawFile: "gb-1948.geojson", padMeters: 250 },
  { id: "monza", rawFile: "it-1922.geojson", padMeters: 250 },
  { id: "spa", rawFile: "be-1925.geojson", padMeters: 250 },
  { id: "suzuka", rawFile: "jp-1962.geojson", padMeters: 250 },
  { id: "monaco", rawFile: "mc-1929.geojson", padMeters: 250 },
  { id: "spielberg", rawFile: "at-1969.geojson", padMeters: 250 },
  { id: "bahrain", rawFile: "bh-2002.geojson", padMeters: 250 },
  { id: "cota", rawFile: "us-2012.geojson", padMeters: 250 },
  { id: "zandvoort", rawFile: "nl-1948.geojson", padMeters: 250 },
];

const REQUEST_PAUSE_MS = 6000;
const MAX_ELEMENTS_BEFORE_SPLIT = 30000;
// Keep only what reads as trackside: grandstands, pits and nearby buildings
// matter; farmhouses half a kilometre out and field fences do not. Caps are
// plan distances from the ribbon, generous enough that no real trackside
// feature can fall outside (verified by logging every dropped NAMED feature
// for review below).
const KEEP_DISTANCE_M: Record<string, number> = {
  grandstand: 150,
  building: 150,
  attraction: 250,
  barrier: 40,
  tunnel: 150,
};

interface OsmNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
}

interface OsmWay {
  type: "way";
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

interface OsmDoc {
  elements: (OsmNode | OsmWay | { type: string })[];
}

async function fetchBbox(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number
): Promise<OsmDoc> {
  const url =
    `https://www.openstreetmap.org/api/0.6/map.json?bbox=${minLon},${minLat},${maxLon},${maxLat}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "lift-and-coast-track-research/1.0" },
  });
  if (!res.ok) throw new Error(`OSM map call failed: ${res.status} ${url}`);
  return (await res.json()) as OsmDoc;
}

function rawBounds(rawFile: string): {
  centerLon: number;
  centerLat: number;
  extentX: number;
  extentZ: number;
} {
  const raw = JSON.parse(readFileSync(`${RAW_DIR}/${rawFile}`, "utf8"));
  const coords = raw.features[0].geometry.coordinates as [number, number][];
  const lons = coords.map((c) => c[0]);
  const lats = coords.map((c) => c[1]);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const kx = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return {
    centerLon,
    centerLat,
    extentX: ((maxLon - minLon) / 2) * kx,
    extentZ: ((maxLat - minLat) / 2) * 111320,
  };
}

// Perpendicular distance-ish simplification (Douglas-Peucker) on lon/lat
// points; epsilon is in degrees (~1.5m at these latitudes).
function simplify(points: [number, number][], eps: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Array(points.length).fill(false);
  keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  const dist = (p: [number, number], a: [number, number], b: [number, number]): number => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
  };
  while (stack.length > 0) {
    const se = stack.pop();
    if (!se) continue;
    const [s, e] = se;
    if (e - s < 2) continue;
    let dmax = -1;
    let idx = s;
    for (let i = s + 1; i < e; i++) {
      const dd = dist(points[i], points[s], points[e]);
      if (dd > dmax) {
        dmax = dd;
        idx = i;
      }
    }
    if (dmax > eps) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export interface VendoredStructure {
  name: string | null;
  kind: "grandstand" | "building" | "barrier" | "attraction" | "tunnel" | "pitlane";
  /** Closed lon/lat ring (barriers: open polyline instead). */
  ring: [number, number][];
  heightM: number | null;
  roofColour: string | null;
  source: string;
}

function parseHeight(tags: Record<string, string>): number | null {
  const raw = tags["height"];
  if (raw) {
    const m = raw.match(/([\d.]+)/);
    if (m) return parseFloat(m[1]);
  }
  const levels = tags["building:levels"];
  if (levels) {
    const m = levels.match(/([\d.]+)/);
    if (m) return parseFloat(m[1]) * 3.5;
  }
  return null;
}

function classify(tags: Record<string, string>): VendoredStructure["kind"] | null {
  if (tags["building"] === "grandstand" || tags["leisure"] === "tribune") return "grandstand";
  if (tags["tunnel"] === "yes" && tags["highway"]) return "tunnel";
  if (tags["barrier"] === "wall" || tags["barrier"] === "fence" || tags["barrier"] === "guard_rail") {
    return "barrier";
  }
  if (tags["tourism"] === "attraction" || tags["attraction"]) return "attraction";
  if (tags["building"]) return "building";
  // Pit lanes are mapped as raceway asphalt like the circuit itself - kept
  // by lane-specific name only ("pit", "Boxenstraße", "Pitstraat", "voie
  // des stands"). A bare "paddock" is NOT enough: paddock service roads
  // ("Paddock Layout") wear raceway tags too but are not the lane, and the
  // distance/share filter in main() cannot tell them apart afterwards.
  // Whether the lane hugs the track or stands off is decided there, by
  // offset share on the resampled polyline - not here by name.
  if (tags["highway"] === "raceway" || tags["raceway"] === "pit_lane") {
    // sport=karting excludes kart-track pit lanes (Spa's sits 60m+ from the
    // F1 ribbon and the old share rule kept it) - only lanes of the mapped
    // circuit itself qualify.
    if (tags["sport"] === "karting") return null;
    const name = `${tags["name"] ?? ""} ${tags["name:en"] ?? ""}`;
    if (/pit|boxen|pitstraat|voie des stands/i.test(name)) return "pitlane";
  }
  return null;
}

function filterAndConvert(doc: OsmDoc): VendoredStructure[] {
  const nodes = new Map<number, [number, number]>();
  for (const e of doc.elements) {
    if (e.type !== "node") continue;
    const node = e as OsmNode;
    nodes.set(node.id, [node.lon, node.lat]);
  }
  const out: VendoredStructure[] = [];
  for (const e of doc.elements) {
    if (e.type !== "way") continue;
    const way = e as OsmWay;
    const tags = way.tags ?? {};
    const kind = classify(tags);
    if (!kind) continue;
    const pts: [number, number][] = [];
    for (const id of way.nodes) {
      const p = nodes.get(id);
      if (p) pts.push(p);
    }
    if (pts.length < 2) continue;
    const closed = pts.length > 2 &&
      Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1e-9 &&
      Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1e-9;
    if (!closed && kind !== "barrier" && kind !== "tunnel" && kind !== "pitlane") continue;
    const simple = simplify(pts, 0.000015);
    const rounded = simple.map(
      ([lon, lat]): [number, number] => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]
    );
    out.push({
      name: tags["name"] ?? tags["name:en"] ?? null,
      kind,
      ring: rounded,
      heightM: parseHeight(tags),
      roofColour: tags["roof:colour"] ?? tags["roof:color"] ?? null,
      source: `OSM way/${way.id}`,
    });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimum plan distance from a ring to the built centerline, in meters. */
function ringDistanceM(
  ring: [number, number][],
  centerLon: number,
  centerLat: number,
  line: [number, number, number][]
): number {
  const kx = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const px = (lon: number) => (lon - centerLon) * kx;
  const pz = (lat: number) => -(lat - centerLat) * 111320;
  let best = Infinity;
  for (let r = 0; r < ring.length; r += 2) {
    const qx = px(ring[r][0]);
    const qz = pz(ring[r][1]);
    for (let i = 0; i < line.length; i += 2) {
      const dx = line[i][0] - qx;
      const dz = line[i][2] - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
  }
  return Math.sqrt(best);
}

/**
 * Longest contiguous stretch of a ring sitting off the ribbon but near it
 * (4-40m), measured on the 10m-resampled polyline. Pit lanes merge into the
 * track at entry/exit, so a minimum-distance test drops them - but the lane
 * body runs hundreds of metres in the near-offset band, while the
 * circuit's own mapped segments sit at ~0 everywhere and distant roads sit
 * past 40m. A share/fraction test can't separate a hugging lane (long
 * merges dilute it: Zandvoort 0.36, Bahrain 0.23) from a circuit segment;
 * a contiguous 150m+ run in the band can.
 */
function longestRunInBandM(
  ring: [number, number][],
  centerLon: number,
  centerLat: number,
  line: [number, number, number][]
): number {
  const kx = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const px = (lon: number) => (lon - centerLon) * kx;
  const pz = (lat: number) => -(lat - centerLat) * 111320;
  const local = ring.map(([lon, lat]): [number, number] => [px(lon), pz(lat)]);
  const dense: [number, number][] = [];
  for (let i = 0; i + 1 < local.length; i++) {
    const [ax, az] = local[i];
    const [bx, bz] = local[i + 1];
    const seg = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(seg / 10));
    for (let k = 0; k < steps; k++) {
      dense.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
    }
  }
  if (local.length > 0) dense.push(local[local.length - 1]);
  let longest = 0;
  let run = 0;
  for (const [qx, qz] of dense) {
    let best = Infinity;
    for (let i = 0; i < line.length; i += 2) {
      const dx = line[i][0] - qx;
      const dz = line[i][2] - qz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) best = d2;
    }
    const dist = Math.sqrt(best);
    if (dist >= 4 && dist <= 40) {
      run += 10;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }
  return longest;
}

export interface TrackSpec {
  id: string;
  rawFile: string;
  padMeters: number;
}

/** Bbox + projection center for a track, shared by the fetch and the file. */
export function trackBbox(track: TrackSpec): {
  centerLon: number;
  centerLat: number;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
} {
  const { centerLon, centerLat, extentX, extentZ } = rawBounds(track.rawFile);
  const kx = 111320 * Math.cos((centerLat * Math.PI) / 180);
  const dLon = (extentX + track.padMeters) / kx;
  const dLat = (extentZ + track.padMeters) / 111320;
  return { centerLon, centerLat, minLon: centerLon - dLon, minLat: centerLat - dLat, maxLon: centerLon + dLon, maxLat: centerLat + dLat };
}

/**
 * Filter a fetched bbox doc down to the vendored structures file. Exported
 * so a response saved to disk by other means (curl, when the runtime's
 * own fetch can't reach the API) converts through the identical logic -
 * see the doc comment on filterAndConvert for the format.
 */
export function processTrackDoc(
  track: TrackSpec,
  doc: OsmDoc,
  bbox: { centerLon: number; centerLat: number }
): void {
  const { centerLon, centerLat } = bbox;
  const count = doc.elements.length;
  console.log(`  ${count} elements`);
  if (count > MAX_ELEMENTS_BEFORE_SPLIT) {
    throw new Error(`${track.id}: too many elements (${count}), split the bbox first`);
  }
  const built = JSON.parse(
    readFileSync(`${scriptDir}/../data/tracks/${track.id}.json`, "utf8")
  );
  const line = built.centerline as [number, number, number][];
  const all = filterAndConvert(doc);
  // Drop everything that cannot read as trackside from the circuit.
  // Pit lanes additionally require a minimum offset: the circuit's own
  // asphalt is mapped the same way, and only the offset lane is wanted.
  const structures = all.filter((s) => {
    const cap = KEEP_DISTANCE_M[s.kind] ?? 150;
    const d = ringDistanceM(s.ring, centerLon, centerLat, line);
    if (s.kind === "pitlane") {
      const runM = longestRunInBandM(s.ring, centerLon, centerLat, line);
      console.log(`  pitlane "${s.name ?? "?"}": longest near-offset run ${runM.toFixed(0)}m`);
      if (runM < 150) return false;
    }
    if (d > cap) {
      if (s.name) console.log(`  drop ${s.kind} "${s.name}" (${d.toFixed(0)}m out)`);
      return false;
    }
    return true;
  });
  const byKind = new Map<string, number>();
  for (const s of structures) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);
  console.log(
    `  kept ${structures.length}: ` +
      [...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(" ")
  );
  writeFileSync(
    `${OUT_DIR}/${track.id}.json`,
    JSON.stringify({ centerLon, centerLat, structures }, null, 2) + "\n"
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  for (const track of TRACKS) {
    const bbox = trackBbox(track);
    console.log(
      `${track.id}: bbox lon[${bbox.minLon.toFixed(4)},${bbox.maxLon.toFixed(4)}] ` +
        `lat[${bbox.minLat.toFixed(4)},${bbox.maxLat.toFixed(4)}]`
    );
    const doc = await fetchBbox(bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat);
    processTrackDoc(track, doc, bbox);
    await sleep(REQUEST_PAUSE_MS);
  }
}

if (process.argv[1]?.endsWith("fetch-structures.mts")) {
  await main();
}
