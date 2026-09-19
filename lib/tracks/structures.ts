import type { TrackData } from "./types";
import { buildTerrainGeometry } from "./terrain";
import { hexToLinearRgb } from "./mesh";
import silverstone from "../../data/tracks/structures/silverstone.json";
import monza from "../../data/tracks/structures/monza.json";
import spa from "../../data/tracks/structures/spa.json";
import suzuka from "../../data/tracks/structures/suzuka.json";
import monaco from "../../data/tracks/structures/monaco.json";
import spielberg from "../../data/tracks/structures/spielberg.json";
import bahrain from "../../data/tracks/structures/bahrain.json";
import cota from "../../data/tracks/structures/cota.json";
import zandvoort from "../../data/tracks/structures/zandvoort.json";
import budapest from "../../data/tracks/structures/budapest.json";
import melbourne from "../../data/tracks/structures/melbourne.json";
import montreal from "../../data/tracks/structures/montreal.json";
import mexico from "../../data/tracks/structures/mexico.json";
import shanghai from "../../data/tracks/structures/shanghai.json";
import interlagos from "../../data/tracks/structures/interlagos.json";
import yasmarina from "../../data/tracks/structures/yasmarina.json";

/**
 * Trackside structures (plan section 4, circuit detail): pit buildings,
 * grandstands, walls and landmarks, placed from mapped data -
 * see scripts/fetch-structures.mts for how data/tracks/structures/*.json
 * is vendored from OpenStreetMap (building=grandstand footprints with real
 * names, pit lanes traced as raceways, named pit buildings). Nothing here
 * is invented: unmapped features (Monaco's temporary tribunes, trees)
 * are omitted rather than fabricated.
 *
 * Rendering is low-poly massing (boxes, one torus) merged into solid
 * (grandstands, buildings, walls, landmarks) and visual-only (tunnel roofs
 * the car drives under) geometry per track. Both sets are VISUAL ONLY, in
 * the game and in the headless harness alike: the physics suite's blind
 * drivers roam metres past the edge where real furniture stands, so solid
 * walls there read as crashes the tests cannot see coming (verified: six
 * gates fail with a structures collider attached). Track limits, surface
 * grip and the off-track reset govern cutting instead; physical walls want
 * perception-aware drivers first.
 */

export type StructureKind =
  | "grandstand"
  | "building"
  | "barrier"
  | "attraction"
  | "tunnel"
  | "pitlane";

export interface VendoredStructure {
  name: string | null;
  kind: StructureKind;
  /** Closed lon/lat ring (open polyline for barriers, tunnels, pit lanes). */
  ring: [number, number][];
  heightM: number | null;
  roofColour: string | null;
  source: string;
}

interface StructuresFile {
  centerLon: number;
  centerLat: number;
  structures: VendoredStructure[];
}

const FILES: Record<string, StructuresFile> = {
  silverstone: silverstone as StructuresFile,
  monza: monza as StructuresFile,
  spa: spa as StructuresFile,
  suzuka: suzuka as StructuresFile,
  monaco: monaco as StructuresFile,
  spielberg: spielberg as StructuresFile,
  bahrain: bahrain as StructuresFile,
  cota: cota as StructuresFile,
  zandvoort: zandvoort as StructuresFile,
  budapest: budapest as StructuresFile,
  melbourne: melbourne as StructuresFile,
  montreal: montreal as StructuresFile,
  mexico: mexico as StructuresFile,
  shanghai: shanghai as StructuresFile,
  interlagos: interlagos as StructuresFile,
  yasmarina: yasmarina as StructuresFile,
};

export function getStructures(trackId: string): VendoredStructure[] {
  return FILES[trackId]?.structures ?? [];
}

export function getStructuresCenter(trackId: string): {
  centerLon: number;
  centerLat: number;
} {
  const file = FILES[trackId];
  if (!file) return { centerLon: 0, centerLat: 0 };
  return { centerLon: file.centerLon, centerLat: file.centerLat };
}

/** Same equirectangular projection scripts/build-track.mts builds with. */
export function projectToLocal(
  lon: number,
  lat: number,
  centerLon: number,
  centerLat: number
): [number, number] {
  const kx = 111320 * Math.cos((centerLat * Math.PI) / 180);
  return [(lon - centerLon) * kx, -(lat - centerLat) * 111320];
}

export interface Footprint {
  cx: number;
  cz: number;
  /** Long-axis yaw, radians. */
  yaw: number;
  lengthM: number;
  widthM: number;
}

/** Oriented bounding box of a ring via normalized PCA (not min/max: a
 * diagonal bar's axis-aligned box is mostly empty). A trailing duplicate
 * closure point (the OSM closed-way convention) is dropped first so it
 * cannot bias the mean. */
export function footprintOf(ring: [number, number][]): Footprint {
  let pts = ring;
  if (ring.length > 1) {
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) {
      pts = ring.slice(0, -1);
    }
  }
  let mx = 0;
  let mz = 0;
  for (const [x, z] of pts) {
    mx += x;
    mz += z;
  }
  mx /= pts.length;
  mz /= pts.length;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (const [x, z] of pts) {
    sxx += (x - mx) ** 2;
    sxz += (x - mx) * (z - mz);
    szz += (z - mz) ** 2;
  }
  const n = pts.length;
  sxx /= n;
  sxz /= n;
  szz /= n;
  const trace = sxx + szz;
  const det = sxx * szz - sxz * sxz;
  const l1 = trace / 2 + Math.sqrt(Math.max(0, (trace / 2) ** 2 - det));
  const yaw = Math.atan2(l1 - sxx, sxz);
  const ux = Math.cos(yaw);
  const uz = Math.sin(yaw);
  let aMin = Infinity;
  let aMax = -Infinity;
  let bMin = Infinity;
  let bMax = -Infinity;
  for (const [x, z] of pts) {
    const a = (x - mx) * ux + (z - mz) * uz;
    const b = -(x - mx) * uz + (z - mz) * ux;
    aMin = Math.min(aMin, a);
    aMax = Math.max(aMax, a);
    bMin = Math.min(bMin, b);
    bMax = Math.max(bMax, b);
  }
  return {
    cx: mx,
    cz: mz,
    yaw,
    lengthM: aMax - aMin,
    widthM: bMax - bMin,
  };
}

// ---------------------------------------------------------------------------
// Massing palette (matte, restrained - these are backdrop, not livery).
// ---------------------------------------------------------------------------

const CONCRETE = hexToLinearRgb("#B4B9C1");
const CONCRETE_DARK = hexToLinearRgb("#828892");
const ROOF = hexToLinearRgb("#5A6068");
const SEATS = hexToLinearRgb("#8A2F24");
const WALL = hexToLinearRgb("#C8C8C8");
const WHEEL_WHITE = hexToLinearRgb("#E8E8E8");
const CABIN = hexToLinearRgb("#C0392B");
const TUNNEL_ROOF = hexToLinearRgb("#3A3D42");

export interface StructureGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  colors: Float32Array;
}

export interface BoxSpec {
  cx: number;
  yBase: number;
  cz: number;
  sx: number;
  sy: number;
  sz: number;
  yaw: number;
  color: readonly [number, number, number];
}

/** Outward-wound box (exported for the winding test in
 * tests/structures.test.ts, which checks every face against its own center
 * rather than trusting this order). */
export function pushBox(
  positions: number[],
  indices: number[],
  colors: number[],
  spec: BoxSpec
): void {
  const base = positions.length / 3;
  const { cx, yBase, cz, sx, sy, sz, yaw, color } = spec;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const corners: [number, number, number][] = [];
  for (const iy of [0, 1]) {
    for (const iz of [-1, 1]) {
      for (let ix = -1; ix <= 1; ix += 2) {
        const lx = (ix * sx) / 2;
        const lz = (iz * sz) / 2;
        corners.push([cx + lx * c + lz * s, yBase + iy * sy, cz - lx * s + lz * c]);
      }
    }
  }
  // Order: (-,-,-)=0, (+,-,-)=1, (+,-,+)=2, (-,-,+)=3,
  //        (-,+,-)=4, (+,+,-)=5, (+,+,+)=6, (-,+,+)=7.
  const order = [0, 1, 3, 2, 4, 5, 7, 6];
  for (const k of order) {
    positions.push(corners[k][0], corners[k][1], corners[k][2]);
    colors.push(color[0], color[1], color[2]);
  }
  const tris = [
    [0, 1, 2],
    [0, 2, 3],
    [4, 6, 5],
    [4, 7, 6],
    [3, 2, 6],
    [3, 6, 7],
    [1, 0, 4],
    [1, 4, 5],
    [1, 5, 6],
    [1, 6, 2],
    [0, 3, 7],
    [0, 7, 4],
  ];
  for (const [a, b, cc] of tris) {
    indices.push(base + a, base + b, base + cc);
  }
}

/** Ground height under a structure: nearest terrain vertex, sunk a metre so
 * long bars never float off a slope. */
function groundY(
  terrain: { positions: Float32Array; columns: number; rows: number; originX: number; originZ: number; cellMeters: number },
  x: number,
  z: number
): number {
  const column = Math.round((x - terrain.originX) / terrain.cellMeters);
  const row = Math.round((z - terrain.originZ) / terrain.cellMeters);
  const c = Math.min(terrain.columns - 1, Math.max(0, column));
  const r = Math.min(terrain.rows - 1, Math.max(0, row));
  return terrain.positions[(r * terrain.columns + c) * 3 + 1] - 1;
}

function buildingHeightM(s: VendoredStructure, fp: Footprint): number {
  if (s.heightM !== null && s.heightM > 0) return Math.min(s.heightM, 20);
  return defaultMassingHeightM(fp);
}

/**
 * Totem-pole guard: a 3m utility cabinet mapped as a building is a shed,
 * not an 8m tower. Default height follows the footprint's short side, so
 * sheds stay sheds while houses and complexes keep the full 8m.
 */
export function defaultMassingHeightM(fp: Footprint): number {
  const short = Math.min(fp.lengthM, fp.widthM);
  return Math.min(8, Math.max(2.5, short * 0.8));
}

/**
 * Buildings that are stands in everything but the tag: mappers name them
 * "Stand F1", "Tribuna X", and a solid slab renders them as a black wall
 * where the circuit has a grandstand. They get stand massing instead.
 */
export function isStandName(name: string | null): boolean {
  if (!name) return false;
  return /\bstand\b|tribun|grandstand/i.test(name);
}

interface Emitter {
  positions: number[];
  indices: number[];
  colors: number[];
}

function emitBox(emitter: Emitter, spec: BoxSpec): void {
  pushBox(emitter.positions, emitter.indices, emitter.colors, spec);
}

/**
 * Grandstand massing from a footprint: plinth, three rising seating steps
 * facing the track, red back wall, roof slab on columns. Fixed ~11m
 * profile regardless of footprint - these are massing models placed where
 * the real stands stand, not replicas.
 *
 * Frame math (all boxes are centered, so only axis alignment matters, never
 * mirroring): u runs along the stand, v across it with +v toward the track.
 * A pushBox yaw of atan2(-uz, ux) maps its local X onto any unit (ux, uz).
 */
function emitGrandstand(
  emitter: Emitter,
  fp: Footprint,
  facing: [number, number],
  ground: number
): void {
  const L = fp.lengthM;
  const W = Math.max(fp.widthM, 10);
  const ux = Math.cos(fp.yaw);
  const uz = Math.sin(fp.yaw);
  let vx = -uz;
  let vz = ux;
  if (vx * facing[0] + vz * facing[1] < 0) {
    vx = -vx;
    vz = -vz;
  }
  const boxYaw = Math.atan2(-uz, ux);
  const box = (
    du: number,
    yBase: number,
    dv: number,
    su: number,
    sy: number,
    sv: number,
    color: readonly [number, number, number]
  ) => {
    emitBox(emitter, {
      cx: fp.cx + du * ux + dv * vx,
      yBase,
      cz: fp.cz + du * uz + dv * vz,
      sx: su,
      sy,
      sz: sv,
      yaw: boxYaw,
      color,
    });
  };
  box(0, ground, 0, L, 2.5, W, CONCRETE);
  const stepDepth = W / 3.4;
  for (let k = 0; k < 3; k++) {
    box(0, ground + 2.5 + k * 1.1, W / 2 - (k + 0.5) * stepDepth, L, 1.1, stepDepth, CONCRETE);
  }
  box(0, ground + 2.5, -W / 2 + 0.5, L, 8, 1, SEATS);
  box(0, ground + 10.5, -W / 4, L + 2, 0.5, W, ROOF);
  for (const du of [-L / 2 + 1.5, L / 2 - 1.5]) {
    for (const dv of [W / 4, -W / 4]) {
      box(du, ground + 2.5, dv, 0.4, 8, 0.4, CONCRETE_DARK);
    }
  }
}

function validHexColor(raw: string | null): readonly [number, number, number] | null {
  if (!raw || !/^#[0-9a-fA-F]{6}$/.test(raw)) return null;
  return hexToLinearRgb(raw);
}

/** Pit/building block: tinted concrete body, glass band, roof slab. The
 * tint varies deterministically by name so neighbours don't read as one
 * poured mass; same name always gives the same tint. */
function emitBuilding(
  emitter: Emitter,
  fp: Footprint,
  ground: number,
  heightM: number,
  roofColour: string | null,
  tintSeed: string
): void {
  let hash = 0;
  for (let i = 0; i < tintSeed.length; i++) hash = (hash * 31 + tintSeed.charCodeAt(i)) | 0;
  const f = 1 + (((hash % 9) + 9) % 9 - 4) * 0.008;
  const body: readonly [number, number, number] = [
    Math.min(1, CONCRETE[0] * f),
    Math.min(1, CONCRETE[1] * f),
    Math.min(1, CONCRETE[2] * f),
  ];
  const yaw = fp.yaw;
  const box = (
    du: number,
    yBase: number,
    dv: number,
    su: number,
    sy: number,
    sv: number,
    color: readonly [number, number, number]
  ) => {
    // Same frame convention as emitGrandstand: box local X runs along u,
    // so the yaw passed to pushBox is negated (see its docs there).
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    emitBox(emitter, {
      cx: fp.cx + du * c + dv * -s,
      yBase,
      cz: fp.cz + du * s + dv * c,
      sx: su,
      sy,
      sz: sv,
      yaw: -yaw,
      color,
    });
  };
  const L = fp.lengthM;
  const W = fp.widthM;
  if (heightM < 4) {
    // Sheds and cabinets: one mass with a cap, no glass band (it would
    // poke out above a 2.5m roof).
    box(0, ground, 0, L, heightM, W, body);
    box(0, ground + heightM, 0, L + 1, 0.6, W + 1, validHexColor(roofColour) ?? ROOF);
    return;
  }
  box(0, ground, 0, L, 2, W + 0.3, CONCRETE_DARK);
  box(0, ground + 2, 0, L, Math.max(1, heightM - 2), W, body);
  box(0, ground + 2 + Math.max(1, heightM - 2) / 2, 0, L + 0.3, 1.6, W + 0.3, [
    0.16, 0.24, 0.32,
  ]);
  box(0, ground + heightM, 0, L + 1, 0.6, W + 1, validHexColor(roofColour) ?? ROOF);
}

/** Vertical ribbon wall following a polyline (pit walls, mapped fences):
 * short yaw-aligned boxes with overlap so corners never gap. */
function emitWallRun(
  emitter: Emitter,
  pts: [number, number, number][],
  heightM: number,
  widthM: number,
  color: readonly [number, number, number]
): void {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay, az] = pts[i];
    const [bx, by, bz] = pts[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    emitBox(emitter, {
      cx: (ax + bx) / 2,
      yBase: (ay + by) / 2,
      cz: (az + bz) / 2,
      sx: len + 0.6,
      sy: heightM,
      sz: widthM,
      yaw: Math.atan2(-dz, dx),
      color,
    });
  }
}

/** Ferris wheel (Suzuka's circuit wheel): vertical torus facing the track,
 * hub, twin towers, eight cabins on the rim. */
function emitFerrisWheel(
  emitter: Emitter,
  cx: number,
  cz: number,
  facing: [number, number],
  ground: number,
  diameterM: number
): void {
  const R = Math.min(30, Math.max(10, diameterM / 2));
  const hubY = ground + R + 3;
  // Ring in the vertical plane whose normal faces the track.
  const nx = facing[0];
  const nz = facing[1];
  const tx = -nz;
  const tz = nx;
  const U = 20;
  const V = 8;
  const tube = 0.8;
  const positions = emitter.positions;
  const indices = emitter.indices;
  const colors = emitter.colors;
  const base = positions.length / 3;
  for (let i = 0; i < U; i++) {
    const a = (i / U) * Math.PI * 2;
    for (let j = 0; j < V; j++) {
      const b = (j / V) * Math.PI * 2;
      const rr = R + tube * Math.cos(b);
      positions.push(
        cx + rr * Math.cos(a) * tx + tube * Math.sin(b) * nx,
        hubY + rr * Math.sin(a),
        cz + rr * Math.cos(a) * tz + tube * Math.sin(b) * nz
      );
      colors.push(WHEEL_WHITE[0], WHEEL_WHITE[1], WHEEL_WHITE[2]);
    }
  }
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < V; j++) {
      const a = base + i * V + j;
      const bq = base + ((i + 1) % U) * V + j;
      const cq = base + ((i + 1) % U) * V + ((j + 1) % V);
      const dq = base + i * V + ((j + 1) % V);
      indices.push(a, bq, cq, a, cq, dq);
    }
  }
  // Twin support towers splayed in the ring plane.
  for (const side of [-1, 1]) {
    const lx = cx + side * R * 0.45 * tx;
    const lz = cz + side * R * 0.45 * tz;
    emitBox(emitter, { cx: lx, yBase: ground, cz: lz, sx: 1.2, sy: hubY - ground, sz: 1.2, yaw: 0, color: WHEEL_WHITE });
  }
  emitBox(emitter, { cx, yBase: hubY - 1, cz, sx: 2, sy: 2, sz: 2, yaw: 0, color: CONCRETE_DARK });
  // Cabins hung around the rim.
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    emitBox(emitter, {
      cx: cx + R * Math.cos(a) * tx,
      yBase: hubY + R * Math.sin(a) - 2.4,
      cz: cz + R * Math.cos(a) * tz,
      sx: 1.8,
      sy: 1.8,
      sz: 1.8,
      yaw: 0,
      color: CABIN,
    });
  }
}

export interface PitWallRun {
  side: 1 | -1;
  fromStation: number;
  toStation: number;
}

/**
 * Pit wall station ranges, derived from the mapped pit lanes: for each lane
 * node near the ribbon, take its station; contiguous coverage (gaps under
 * 80m merged, runs under 100m dropped as noise) becomes wall, extended a
 * little past the lane ends. Where no lane is mapped (Spa), pit-named
 * buildings stand in as sparse proxy points. Side comes from the median
 * signed lateral offset, so the wall lands between track and pits.
 */
export function pitWallRuns(
  track: TrackData,
  lanes: { ring: [number, number][]; centerLon: number; centerLat: number }[],
  buildings: { ring: [number, number][]; centerLon: number; centerLat: number; name: string | null }[]
): PitWallRun[] {
  const n = track.centerline.length;
  const L = track.lengthMeters;
  const samples: { station: number; lateral: number }[] = [];
  const pushLocal = (qx: number, qz: number, cap: number) => {
    let best = Infinity;
    let bestI = 0;
    for (let i = 0; i < n; i += 2) {
      const [x, , z] = track.centerline[i];
      const d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < best) {
        best = d2;
        bestI = i;
      }
    }
    if (best > cap * cap) return;
    const [x, , z] = track.centerline[bestI];
    const [px, , pz] = track.centerline[(bestI - 1 + n) % n];
    const [nx, , nz] = track.centerline[(bestI + 1) % n];
    const tx = nx - px;
    const tz = nz - pz;
    const len = Math.hypot(tx, tz) || 1;
    samples.push({
      station: (bestI / n) * L,
      lateral: ((qx - x) * -tz + (qz - z) * tx) / len,
    });
  };
  const push = (lon: number, lat: number, cLon: number, cLat: number, cap: number) => {
    const kx = 111320 * Math.cos((cLat * Math.PI) / 180);
    pushLocal((lon - cLon) * kx, -(lat - cLat) * 111320, cap);
  };
  for (const lane of lanes) {
    // Resample at 10m: mapped lanes are simplified to ~1.5m epsilon, so a
    // straight lane keeps only its endpoints - raw nodes would read as
    // 150m+ gaps and the merge rule below would shred the wall into noise.
    // Consecutive nodes are connected by the lane, so interpolating along
    // segments is faithful, not invented.
    const kx = 111320 * Math.cos((lane.centerLat * Math.PI) / 180);
    const localPts = lane.ring.map(
      ([lon, lat]): [number, number] => [(lon - lane.centerLon) * kx, -(lat - lane.centerLat) * 111320]
    );
    for (let i = 0; i + 1 < localPts.length; i++) {
      const [ax, az] = localPts[i];
      const [bx, bz] = localPts[i + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      const steps = Math.max(1, Math.round(seg / 10));
      for (let k = 0; k < steps; k++) {
        pushLocal(ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps, 60);
      }
    }
    if (localPts.length > 0) {
      const [ex, ez] = localPts[localPts.length - 1];
      pushLocal(ex, ez, 60);
    }
  }
  if (samples.length === 0) {
    for (const b of buildings) {
      if (!b.name || !/^P\d/i.test(b.name)) continue;
      const cx = b.ring.reduce((a, p) => a + p[0], 0) / b.ring.length;
      const cy = b.ring.reduce((a, p) => a + p[1], 0) / b.ring.length;
      push(cx, cy, b.centerLon, b.centerLat, 100);
    }
  }
  if (samples.length === 0) return [];
  samples.sort((a, b) => a.station - b.station);
  const runs: PitWallRun[] = [];
  let start = 0;
  const flush = (a: number, b: number) => {
    if (b - a < 0) return;
    const span = samples.slice(a, b + 1);
    if (span.length < 2) return;
    const lats = span.map((s) => s.lateral).sort((x, y) => x - y);
    const median = lats[Math.floor(lats.length / 2)];
    if (Math.abs(median) < 1e-6) return;
    const length = span[span.length - 1].station - span[0].station;
    if (length < 100) return;
    runs.push({
      side: median > 0 ? 1 : -1,
      fromStation: Math.max(0, span[0].station - 15),
      toStation: Math.min(L, span[span.length - 1].station + 15),
    });
  };
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].station - samples[i - 1].station > 80) {
      flush(start, i - 1);
      start = i;
    }
  }
  flush(start, samples.length - 1);
  // A run wrapping the lap origin (pit straight contains index 0 on every
  // circuit so far) splits into a tail and a head above - rejoin them.
  if (runs.length >= 2) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first.fromStation <= 80 && last.toStation >= L - 80 && first.side === last.side) {
      runs[0] = { side: first.side, fromStation: last.fromStation - L, toStation: first.toStation };
      runs.pop();
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Top-level build.
// ---------------------------------------------------------------------------

export interface StructuresBuild {
  /** Grandstands, buildings, walls, landmarks: rendered + collider. */
  solid: StructureGeometry;
  /** Tunnel roofs the car drives under: rendered only, never a collider. */
  visual: StructureGeometry;
}

interface TrackSample {
  station: number;
  /** Meters from centerline, + = track-right (matches mesh.ts rightX/Z). */
  lateral: number;
  trackY: number;
  /** pushBox yaw mapping local X onto the track tangent. */
  tangentYaw: number;
  halfW: number;
}

/** Nearest centerline point with the frame needed to place/face structures. */
function nearestTrack(track: TrackData, x: number, z: number): TrackSample {
  const n = track.centerline.length;
  const L = track.lengthMeters;
  let best = Infinity;
  let bestI = 0;
  for (let i = 0; i < n; i++) {
    const dx = track.centerline[i][0] - x;
    const dz = track.centerline[i][2] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      bestI = i;
    }
  }
  const [cx, cy, cz] = track.centerline[bestI];
  const [px, , pz] = track.centerline[(bestI - 1 + n) % n];
  const [nx, , nz] = track.centerline[(bestI + 1) % n];
  const tx = nx - px;
  const tz = nz - pz;
  const len = Math.hypot(tx, tz) || 1;
  return {
    station: (bestI / n) * L,
    lateral: ((x - cx) * -tz + (z - cz) * tx) / len,
    trackY: cy,
    tangentYaw: Math.atan2(-tz, tx),
    halfW: track.width[bestI] / 2,
  };
}

function finish(emitter: Emitter): StructureGeometry {
  return {
    positions: new Float32Array(emitter.positions),
    indices: new Uint32Array(emitter.indices),
    colors: new Float32Array(emitter.colors),
  };
}

/**
 * Shove a footprint out of the ribbon: OSM footprints are mapped coarsely,
 * so a pit garage drawn onto the asphalt is mapping noise, not architecture
 * over the racing line. Samples the CENTERLINE against the footprint (not
 * just its corners - the track can cross the middle of a long bar whose
 * corners are far from the ribbon): for the deepest inside point, the box
 * exits via its nearest edge (a garage the track clips along its length
 * slides sideways, not along itself), by the distance to that edge plus
 * margin. Returns the shifted center, or null when the footprint sits so
 * far over the track that shifting would relocate it rather than nudge it
 * (bogus - drop it instead of inventing a new address). Worst-point
 * descent over several passes: each pass clears the deepest inside point,
 * which can expose the next one along a diagonal crossing. If the
 * footprint ping-pongs between two arms of one lap it never settles, and
 * the build drops it rather than leaving it on the road.
 *
 * Exported for the unit test (a bar drawn across the ribbon must come back
 * shifted or null).
 */
export function resolveOverlap(
  track: TrackData,
  fp: Footprint
): { cx: number; cz: number } | null {
  // Coarse footprints sit further out: a 350m paddock complex is mapped to
  // the nearest road, not surveyed, so its edge wants more than the minimum
  // nudge - scale the margin with the footprint, capped where extra metres
  // stop buying honesty.
  const MARGIN = 1.5 + Math.min(8, Math.max(fp.lengthM, fp.widthM) * 0.025);
  const ux = Math.cos(fp.yaw);
  const uz = Math.sin(fp.yaw);
  const vx = -uz;
  const vz = ux;
  const hl = fp.lengthM / 2;
  const hw = fp.widthM / 2;
  const n = track.centerline.length;
  let cx = fp.cx;
  let cz = fp.cz;
  // Worst-point descent: each pass clears the deepest inside point, which
  // can expose the next one along a diagonal crossing (a wide bar takes
  // several passes to slide out from under the ribbon). If the footprint
  // ping-pongs between two arms of one lap it never settles - verify at
  // the end and drop it rather than leave it on the road.
  for (let pass = 0; pass < 8; pass++) {
    let shiftX = 0;
    let shiftZ = 0;
    let shiftLen = 0;
    for (let i = 0; i < n; i += 2) {
      const [x, , z] = track.centerline[i];
      const rx = x - cx;
      const rz = z - cz;
      const a = rx * ux + rz * uz;
      const b = -rx * uz + rz * ux;
      // Distance from the centerline point to the box (zero when the track
      // passes through it); the box must clear the ASPHALT, not just the
      // centerline, so the keep-out is the local half width plus a metre of
      // buffer - the test below only demands half a metre, and the two
      // disagree near rotated box corners (lateral vs plan distance), so
      // the build enforces strictly more than the test checks.
      const da = Math.max(Math.abs(a) - hl, 0);
      const db = Math.max(Math.abs(b) - hw, 0);
      const outside = Math.hypot(da, db);
      const clear = track.width[i] / 2 + 0.5;
      if (outside >= clear) continue;
      const need = clear - outside + MARGIN;
      // Exit via the nearest box edge: the box moves the opposite way.
      const exitU = hl - Math.min(Math.abs(a), hl);
      const exitV = hw - Math.min(Math.abs(b), hw);
      let dx: number;
      let dz: number;
      if (exitU < exitV) {
        const s = a >= 0 ? -1 : 1;
        dx = ux * s;
        dz = uz * s;
      } else {
        const s = b >= 0 ? -1 : 1;
        dx = vx * s;
        dz = vz * s;
      }
      if (need > shiftLen) {
        shiftLen = need;
        shiftX = dx;
        shiftZ = dz;
      }
    }
    if (shiftLen <= 0) return { cx, cz };
    // Mostly over the track rather than beside it: not salvageable.
    if (shiftLen > Math.min(fp.lengthM, fp.widthM) / 2) return null;
    cx += shiftX * shiftLen;
    cz += shiftZ * shiftLen;
  }
  return null;
}

/**
 * Split a mapped fence line at ribbon crossings: gates where fences cross
 * the circuit are real, but a solid collider across the racing line is not
 * - the wall runs up to the track edge with a gap at the road, like the
 * gate it maps. Points are plan [x, z]; ground heights are applied by the
 * caller per sub-run.
 *
 * Resamples at 8m first: mapped ways are simplified, so consecutive nodes
 * can sit on opposite sides of the ribbon with the crossing invisible in
 * the raw points - only the SEGMENTS reveal it. A segment is cut when any
 * of its resampled points falls inside the keep-out (8m sampling always
 * lands a point inside a 10m+ wide keep-out, so no crossing hides between
 * samples, while kilometre-long park boundaries stay cheap).
 */
function splitRunAtRibbon(track: TrackData, pts: [number, number][]): [number, number][][] {
  const dense: [number, number][] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const seg = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(seg / 8));
    for (let k = 0; k < steps; k++) {
      dense.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
    }
  }
  if (pts.length > 0) dense.push(pts[pts.length - 1]);
  const runs: [number, number][][] = [];
  let current: [number, number][] = [];
  for (const [x, z] of dense) {
    const near = nearestTrack(track, x, z);
    if (Math.abs(near.lateral) < near.halfW + 1.5) {
      if (current.length >= 2) runs.push(current);
      current = [];
    } else {
      current.push([x, z]);
    }
  }
  if (current.length >= 2) runs.push(current);
  return runs;
}

/**
 * Massing for a whole circuit from the vendored OSM data. Caps keep
 * mislabeled ways out of the scene: a "grandstand" longer than any real
 * stand is a road with the wrong tag, a building bigger than a factory is
 * a park boundary. Pit lanes themselves stay unrendered (no mapped surface
 * data) - they contribute the pit walls only.
 */
export function buildStructureGeometry(track: TrackData): StructuresBuild {
  const empty = (): StructureGeometry => ({
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    colors: new Float32Array(0),
  });
  const file = FILES[track.id];
  if (!file) return { solid: empty(), visual: empty() };
  const terrain = buildTerrainGeometry(track);
  const solid: Emitter = { positions: [], indices: [], colors: [] };
  const visual: Emitter = { positions: [], indices: [], colors: [] };
  const local = (lon: number, lat: number): [number, number] =>
    projectToLocal(lon, lat, file.centerLon, file.centerLat);

  const lanes: { ring: [number, number][]; centerLon: number; centerLat: number }[] = [];
  const namedBuildings: {
    ring: [number, number][];
    centerLon: number;
    centerLat: number;
    name: string | null;
  }[] = [];
  const tunnels: [number, number][][] = [];

  for (const s of file.structures) {
    const pts = s.ring.map(([lon, lat]) => local(lon, lat));
    switch (s.kind) {
      case "pitlane": {
        lanes.push({ ring: s.ring, centerLon: file.centerLon, centerLat: file.centerLat });
        break;
      }
      case "grandstand": {
        const fp = footprintOf(pts);
        // Longer than any real stand: a road carrying the wrong tag (seen
        // once at Silverstone), not architecture.
        if (fp.lengthM > 400 || fp.lengthM < 3) break;
        const placed = resolveOverlap(track, fp);
        if (!placed) break;
        const sfp = { ...fp, cx: placed.cx, cz: placed.cz };
        const near = nearestTrack(track, sfp.cx, sfp.cz);
        let fx = track.centerline[Math.round((near.station / track.lengthMeters) * track.centerline.length) % track.centerline.length][0] - sfp.cx;
        let fz = track.centerline[Math.round((near.station / track.lengthMeters) * track.centerline.length) % track.centerline.length][2] - sfp.cz;
        const fl = Math.hypot(fx, fz) || 1;
        fx /= fl;
        fz /= fl;
        emitGrandstand(solid, sfp, [fx, fz], groundY(terrain, sfp.cx, sfp.cz));
        break;
      }
      case "building": {
        const fp = footprintOf(pts);
        if (fp.lengthM > 500 || fp.widthM > 500) break;
        namedBuildings.push({
          ring: s.ring,
          centerLon: file.centerLon,
          centerLat: file.centerLat,
          name: s.name,
        });
        const placed = resolveOverlap(track, fp);
        if (!placed) break;
        const sfp = { ...fp, cx: placed.cx, cz: placed.cz };
        if (isStandName(s.name)) {
          // A stand wearing a building tag (Spa's "Stand F1"): stepped
          // stand massing, facing the track like any other grandstand.
          const near = nearestTrack(track, sfp.cx, sfp.cz);
          const tIdx = Math.round((near.station / track.lengthMeters) * track.centerline.length) % track.centerline.length;
          const fx = track.centerline[tIdx][0] - sfp.cx;
          const fz = track.centerline[tIdx][2] - sfp.cz;
          const fl = Math.hypot(fx, fz) || 1;
          emitGrandstand(solid, sfp, [fx / fl, fz / fl], groundY(terrain, sfp.cx, sfp.cz));
          break;
        }
        emitBuilding(
          solid,
          { ...sfp, lengthM: Math.max(3, sfp.lengthM), widthM: Math.max(3, sfp.widthM) },
          groundY(terrain, sfp.cx, sfp.cz),
          buildingHeightM(s, sfp),
          s.roofColour,
          s.name ?? s.source
        );
        break;
      }
      case "barrier": {
        // Split at ribbon crossings (gates): the wall runs up to the track
        // edge with a gap at the road, never across the racing line.
        for (const piece of splitRunAtRibbon(track, pts)) {
          const run: [number, number, number][] = piece.map(([x, z]) => [
            x,
            groundY(terrain, x, z),
            z,
          ]);
          emitWallRun(solid, run, 1.2, 0.4, WALL);
        }
        break;
      }
      case "attraction": {
        const fp = footprintOf(pts);
        const tx = nearestTrack(track, fp.cx, fp.cz);
        const tIdx = Math.round((tx.station / track.lengthMeters) * track.centerline.length) % track.centerline.length;
        const fx = track.centerline[tIdx][0] - fp.cx;
        const fz = track.centerline[tIdx][2] - fp.cz;
        const fl = Math.hypot(fx, fz) || 1;
        // A venue boundary tagged as an attraction (the whole Spa site is
        // mapped that way) is not a structure - only the landmark scale and
        // below gets massing.
        if ((!s.name || !/wheel|ホイール|roue/i.test(s.name)) && (fp.lengthM > 150 || fp.widthM > 150)) {
          break;
        }
        if (s.name && /wheel|ホイール|roue/i.test(s.name)) {
          // Suzuka's circuit wheel: torus + towers + cabins (see
          // emitFerrisWheel), facing the track.
          emitFerrisWheel(
            solid,
            fp.cx,
            fp.cz,
            [fx / fl, fz / fl],
            groundY(terrain, fp.cx, fp.cz),
            Math.max(fp.lengthM, fp.widthM)
          );
        } else {
          // Signs and park buildings: plain massing block, kept out of the
          // ribbon like everything else.
          const placed = resolveOverlap(track, fp);
          if (!placed) break;
          const sfp = { ...fp, cx: placed.cx, cz: placed.cz };
          emitBuilding(
            solid,
            { ...sfp, lengthM: Math.max(3, sfp.lengthM), widthM: Math.max(3, sfp.widthM) },
            groundY(terrain, sfp.cx, sfp.cz),
            defaultMassingHeightM(sfp),
            s.roofColour,
            s.name ?? s.source
          );
        }
        break;
      }
      case "tunnel": {
        tunnels.push(pts);
        break;
      }
    }
  }

  // Pit walls between track and pits, from the mapped lanes.
  const runs = pitWallRuns(track, lanes, namedBuildings);
  const n = track.centerline.length;
  const L = track.lengthMeters;
  for (const run of runs) {
    const runPts: [number, number, number][] = [];
    for (let s = run.fromStation; s <= run.toStation; s += 4) {
      const sm = ((s % L) + L) % L;
      const idx = Math.round((sm / L) * n) % n;
      const [cx, cy, cz] = track.centerline[idx];
      const [px, , pz] = track.centerline[(idx - 1 + n) % n];
      const [nx, , nz] = track.centerline[(idx + 1) % n];
      const tx = nx - px;
      const tz = nz - pz;
      const len = Math.hypot(tx, tz) || 1;
      const off = run.side * (track.width[idx] / 2 + 2.5);
      runPts.push([cx + (-tz / len) * off, cy - 0.3, cz + (tx / len) * off]);
    }
    if (runPts.length >= 2) emitWallRun(solid, runPts, 1.0, 0.5, WALL);
  }

  // Tunnel roofs: only tunnels running ALONG the track (station span 40m+,
  // i.e. the car actually travels inside them - Monaco's tunnel). Short
  // perpendicular crossings are city streets on bridges or diving under;
  // without elevation data a slab there would float over nothing half the
  // time, so they are omitted rather than guessed. Built as short segments
  // following the ribbon's own height, so a flat roof never buries a
  // climbing track (or floats over a diving one).
  for (const pts of tunnels) {
    const stations: { station: number; dist: number; touch: boolean }[] = pts.map(([x, z]) => {
      const near = nearestTrack(track, x, z);
      return {
        station: near.station,
        dist: Math.abs(near.lateral),
        touch: Math.abs(near.lateral) < near.halfW + 4,
      };
    });
    const along = stations.filter((s) => s.dist <= 30);
    if (along.length < 2) continue;
    // A road merely paralleling the track never touches the ribbon - its
    // slab would sit over asphalt where nothing crosses. Only tunnels the
    // car actually travels through (or under a crossing of) get a roof.
    if (!along.some((s) => s.touch)) continue;
    // Unwrap along the polyline order so the lap origin cannot inflate the
    // span - but split first on 400m+ station jumps between consecutive
    // nodes. Those are mapping jumps (a way leaping across the lap, like
    // Suzuka's 1.3km portal-to-portal jump), not tunnel: interpolating a
    // roof across the gap would slab a kilometre of open track. Genuine
    // runs keep nodes every few dozen metres (Monaco's tunnel: ~35m).
    const runs: number[][] = [];
    let current: number[] = [along[0].station];
    for (let i = 1; i < along.length; i++) {
      let d = along[i].station - along[i - 1].station;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      if (Math.abs(d) > 400) {
        runs.push(current);
        current = [along[i].station];
      } else {
        current.push(current[current.length - 1] + d);
      }
    }
    runs.push(current);
    for (const unwrapped of runs) {
      if (unwrapped.length < 2) continue;
      const span = Math.abs(unwrapped[unwrapped.length - 1] - unwrapped[0]);
      if (span < 40) continue;
      const s0 = Math.min(unwrapped[0], unwrapped[unwrapped.length - 1]);
      const s1 = Math.max(unwrapped[0], unwrapped[unwrapped.length - 1]);
      for (let s = s0; s <= s1; s += 15) {
        const sm = ((s % L) + L) % L;
        const idx = Math.round((sm / L) * n) % n;
        const [cx, cy, cz] = track.centerline[idx];
        const [px, , pz] = track.centerline[(idx - 1 + n) % n];
        const [nx, , nz] = track.centerline[(idx + 1) % n];
        const tx = nx - px;
        const tz = nz - pz;
        emitBox(visual, {
          cx,
          yBase: cy + 5.5,
          cz,
          sx: 19,
          sy: 0.6,
          sz: track.width[idx] + 12,
          yaw: Math.atan2(-tz, tx),
          color: TUNNEL_ROOF,
        });
      }
    }
  }

  return { solid: finish(solid), visual: finish(visual) };
}