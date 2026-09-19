import * as THREE from "three";
import type { TrackData } from "./types";
import { buildTerrainGeometry, sampleTerrainHeight } from "./terrain";
import { GRAVEL_COLOR, hexToLinearRgb } from "./mesh";
import { getStructures, getStructuresCenter, projectToLocal } from "./structures";

/**
 * Trackside flora (plan section 4, circuit detail): low-poly trees placed
 * from a seeded RNG, one InstancedMesh per species per track (a few hundred
 * trees for one draw call). Strictly visual, like the structures massing -
 * the physics suite's blind drivers roam the runoff, so nothing here
 * collides, and nothing is placed where a car drives.
 *
 * Species follow the circuits' real settings, not a generic tree: cherry
 * blossom at Suzuka, Lombardy poplars down Monza's park avenues, Ardennes
 * spruce around Spa, oaks at Silverstone, cypress and broadleaf at Monaco.
 * Nothing is invented beyond that mapping - counts, tints and spots are
 * deterministic from the per-track seed, so every session and every
 * screenshot agrees.
 */

export type CanopyShape = "broadleaf" | "conifer";

export interface FloraSpecies {
  /** Broadleaf: trunk + icosahedron canopy. Conifer: trunk + stacked cones. */
  shape: CanopyShape;
  /** sRGB canopy palette - one entry picked per instance, so stands vary. */
  canopyColors: string[];
  /** Trunk sRGB color (shared, unbothered by per-instance tint). */
  trunkColor: string;
  /** Canopy radius range, meters. */
  canopySizeM: [number, number];
  /** Total tree height range, meters. */
  heightM: [number, number];
  /** Share of this track's instances. Weights need not sum to one. */
  weight: number;
}

export interface FloraConfig {
  species: FloraSpecies[];
  /** Instances per kilometre of lap. */
  densityPerKm: number;
  /** Lateral band from the ribbon edge trees may occupy. */
  lateralMinM: number;
  lateralMaxM: number;
  seed: number;
}

const OAK_GREEN = ["#4A7C3A", "#557F35", "#3F7032"];
const POPLAR_GREEN = ["#2F5D33", "#38682E", "#274E2C"];
const SPRUCE_GREEN = ["#24402E", "#2B4A35", "#1E3627"];
const CHERRY_PINK = ["#E7A6C4", "#D98BB0", "#F0BCD4", "#C97B9E"];
const CHERRY_LEAF = ["#5A8C46", "#4E7D3D"];
const CYPRESS_GREEN = ["#2E4A2F", "#354F33", "#283F29"];
const MONACO_LEAF = ["#5C8A44", "#527A3C", "#679551"];
const DESERT_SCRUB = ["#9A9A6B", "#8A8A5E", "#A8A878"];
const TEXAS_OAK = ["#4E7C3C", "#557F35", "#436F34"];
const JUNIPER_GREEN = ["#3A5A3A", "#425E38", "#334E33"];
const DUNE_PINE = ["#3D5A3C", "#46653F", "#355236"];
const PUSZTA_GREEN = ["#5A7C40", "#647F45", "#4F7038"];
const EUCALYPT_GREEN = ["#6A8A5A", "#75946A", "#5D7F52"];
const MAPLE_GREEN = ["#4E7D3A", "#578747", "#457033"];
const PALM_GREEN = ["#4F7D3A", "#5A8A44", "#467033"];
const TRUNK_BROWN = "#5A4632";

const FLORA: Record<string, FloraConfig> = {
  silverstone: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: OAK_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 9],
        weight: 1,
      },
    ],
    densityPerKm: 60,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1948,
  },
  monza: {
    species: [
      {
        shape: "conifer",
        canopyColors: POPLAR_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.2, 1.8],
        heightM: [9, 14],
        weight: 1,
      },
    ],
    densityPerKm: 55,
    lateralMinM: 8,
    lateralMaxM: 50,
    seed: 1922,
  },
  spa: {
    species: [
      {
        shape: "conifer",
        canopyColors: SPRUCE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.8, 2.8],
        heightM: [7, 12],
        weight: 1,
      },
    ],
    densityPerKm: 70,
    lateralMinM: 8,
    lateralMaxM: 60,
    seed: 1925,
  },
  suzuka: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: CHERRY_PINK,
        trunkColor: "#4A3A30",
        canopySizeM: [2.2, 3.4],
        heightM: [4.5, 6.5],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: CHERRY_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 9],
        weight: 1,
      },
    ],
    densityPerKm: 65,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1962,
  },
  monaco: {
    species: [
      {
        shape: "conifer",
        canopyColors: CYPRESS_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [0.9, 1.4],
        heightM: [6, 10],
        weight: 1,
      },
      {
        shape: "broadleaf",
        canopyColors: MONACO_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2, 3],
        heightM: [5, 8],
        weight: 1,
      },
    ],
    densityPerKm: 45,
    lateralMinM: 8,
    lateralMaxM: 40,
    seed: 1929,
  },
  spielberg: {
    species: [
      {
        shape: "conifer",
        canopyColors: SPRUCE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.8, 2.8],
        heightM: [7, 12],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: OAK_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 9],
        weight: 1,
      },
    ],
    densityPerKm: 65,
    lateralMinM: 8,
    lateralMaxM: 60,
    seed: 1969,
  },
  bahrain: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: DESERT_SCRUB,
        trunkColor: "#6B5B43",
        canopySizeM: [1, 2],
        heightM: [2.5, 4],
        weight: 1,
      },
    ],
    densityPerKm: 22,
    lateralMinM: 10,
    lateralMaxM: 60,
    seed: 2004,
  },
  cota: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: TEXAS_OAK,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4.5],
        heightM: [5, 8],
        weight: 2,
      },
      {
        shape: "broadleaf",
        canopyColors: JUNIPER_GREEN,
        trunkColor: "#4E4234",
        canopySizeM: [1.5, 2.5],
        heightM: [3, 5],
        weight: 1,
      },
    ],
    densityPerKm: 55,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 2012,
  },
  zandvoort: {
    species: [
      {
        shape: "conifer",
        canopyColors: DUNE_PINE,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.5, 2.5],
        heightM: [6, 10],
        weight: 1,
      },
      {
        shape: "broadleaf",
        canopyColors: MONACO_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.5, 2.5],
        heightM: [3, 5],
        weight: 1,
      },
    ],
    densityPerKm: 50,
    lateralMinM: 8,
    lateralMaxM: 45,
    seed: 1948,
  },
  budapest: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: PUSZTA_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2, 3.5],
        heightM: [5, 8],
        weight: 2,
      },
      {
        shape: "conifer",
        canopyColors: CYPRESS_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.5, 2.5],
        heightM: [6, 10],
        weight: 1,
      },
    ],
    densityPerKm: 55,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1986,
  },
  melbourne: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: EUCALYPT_GREEN,
        trunkColor: "#6E6A5E",
        canopySizeM: [2.5, 4],
        heightM: [7, 11],
        weight: 1,
      },
    ],
    densityPerKm: 60,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1996,
  },
  montreal: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: MAPLE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 10],
        weight: 1,
      },
    ],
    densityPerKm: 60,
    lateralMinM: 8,
    lateralMaxM: 50,
    seed: 1978,
  },
  mexico: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: JUNIPER_GREEN,
        trunkColor: "#4E4234",
        canopySizeM: [1.5, 2.5],
        heightM: [3, 5],
        weight: 2,
      },
      {
        shape: "conifer",
        canopyColors: CYPRESS_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [0.9, 1.4],
        heightM: [6, 10],
        weight: 1,
      },
    ],
    densityPerKm: 45,
    lateralMinM: 8,
    lateralMaxM: 50,
    seed: 1962,
  },
  shanghai: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: CHERRY_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2, 3.5],
        heightM: [5, 8],
        weight: 1,
      },
    ],
    densityPerKm: 55,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 2004,
  },
  interlagos: {
    species: [
      {
        shape: "broadleaf",
        canopyColors: TEXAS_OAK,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4.5],
        heightM: [6, 10],
        weight: 1,
      },
    ],
    densityPerKm: 60,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1940,
  },
  yasmarina: {
    species: [
      {
        // Date-palm proportions (tall trunk, small crown) - fronds are
        // beyond the low-poly vocabulary, but the silhouette reads.
        // Young landscaping height: the broadleaf stack tops out around
        // 5m at this canopy size regardless of the height band.
        shape: "broadleaf",
        canopyColors: PALM_GREEN,
        trunkColor: "#7A6A4E",
        canopySizeM: [1.2, 2],
        heightM: [5, 7],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: DESERT_SCRUB,
        trunkColor: "#6B5B43",
        canopySizeM: [1, 2],
        heightM: [2.5, 4],
        weight: 1,
      },
    ],
    densityPerKm: 40,
    lateralMinM: 8,
    lateralMaxM: 45,
    seed: 2009,
  },
  hockenheim: {
    // The Hardtwald forest the stadium section sits in: mostly pine with
    // broadleaf mixed in, dense on the forest straights.
    species: [
      {
        shape: "conifer",
        canopyColors: SPRUCE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.8, 2.8],
        heightM: [7, 12],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: OAK_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 9],
        weight: 1,
      },
    ],
    densityPerKm: 70,
    lateralMinM: 8,
    lateralMaxM: 60,
    seed: 1932,
  },
  sepang: {
    // Tropical oil-palm plantation grid around the circuit: tall trunks,
    // small crowns, high density.
    species: [
      {
        shape: "broadleaf",
        canopyColors: PALM_GREEN,
        trunkColor: "#6B5B43",
        canopySizeM: [1.5, 2.5],
        heightM: [7, 11],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: CHERRY_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2, 3.5],
        heightM: [5, 8],
        weight: 1,
      },
    ],
    densityPerKm: 60,
    lateralMinM: 8,
    lateralMaxM: 55,
    seed: 1999,
  },
  sochi: {
    // Olympic Park landscaping: ornamental pines and parkland broadleaf,
    // moderate density on flat ground.
    species: [
      {
        shape: "conifer",
        canopyColors: DUNE_PINE,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.5, 2.5],
        heightM: [6, 10],
        weight: 1,
      },
      {
        shape: "broadleaf",
        canopyColors: MONACO_LEAF,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2, 3],
        heightM: [5, 8],
        weight: 1,
      },
    ],
    densityPerKm: 50,
    lateralMinM: 8,
    lateralMaxM: 45,
    seed: 2014,
  },
  nurburgring: {
    // Eifel forest: dense spruce on the hillsides around the GP-Strecke.
    species: [
      {
        shape: "conifer",
        canopyColors: SPRUCE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [1.8, 2.8],
        heightM: [7, 12],
        weight: 3,
      },
      {
        shape: "broadleaf",
        canopyColors: MAPLE_GREEN,
        trunkColor: TRUNK_BROWN,
        canopySizeM: [2.5, 4],
        heightM: [6, 10],
        weight: 1,
      },
    ],
    densityPerKm: 70,
    lateralMinM: 8,
    lateralMaxM: 60,
    seed: 1927,
  },
};

export function getFloraConfig(trackId: string): FloraConfig | null {
  return FLORA[trackId] ?? null;
}

/** Deterministic RNG (mulberry32) - same seed, same forest, every run. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FloraInstance {
  x: number;
  y: number;
  z: number;
  /** Yaw radians. */
  yaw: number;
  /** Uniform scale. */
  scale: number;
  /** Index into the species' canopyColors. */
  colorIndex: number;
}

export interface FloraBuild {
  speciesIndex: number;
  geometry: THREE.BufferGeometry;
  instances: FloraInstance[];
  /** Resolved sRGB hex per instance (palette pick, testable without three). */
  colors: string[];
}

function pushPart(
  positions: number[],
  indices: number[],
  base: { value: number },
  geometry: THREE.BufferGeometry
): void {
  const source = geometry.toNonIndexed();
  const pos = source.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    indices.push(base.value + i);
  }
  base.value += pos.count;
  source.dispose();
  geometry.dispose();
}

/**
 * One merged tree geometry per species: trunk (brown) below, canopy
 * (white - tinted per instance) above. Vertex colors carry the split so a
 * single InstancedMesh + instanceColor does the whole stand.
 */
export function buildSpeciesGeometry(
  species: FloraSpecies,
  canopyRadius: number,
  heightM: number
): THREE.BufferGeometry {
  const trunkH = Math.max(1, heightM * 0.35);
  const trunkR = Math.max(0.12, canopyRadius * 0.09);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const base = { value: 0 };
  const [trunkR1, trunkG1, trunkB1] = hexToLinearRgb(species.trunkColor);

  const trunk = new THREE.CylinderGeometry(trunkR, trunkR * 1.3, trunkH, 5);
  trunk.translate(0, trunkH / 2, 0);
  const trunkStart = positions.length / 3;
  pushPart(positions, indices, base, trunk);
  for (let i = trunkStart; i < positions.length / 3; i++) {
    colors.push(trunkR1, trunkG1, trunkB1);
  }

  if (species.shape === "broadleaf") {
    const canopy = new THREE.IcosahedronGeometry(canopyRadius, 1);
    // Slightly squashed - broadleaf crowns are wider than tall.
    canopy.scale(1, 0.85, 1);
    canopy.translate(0, trunkH + canopyRadius * 0.55, 0);
    const canopyStart = positions.length / 3;
    pushPart(positions, indices, base, canopy);
    for (let i = canopyStart; i < positions.length / 3; i++) {
      colors.push(1, 1, 1);
    }
  } else {
    // Fastigiate cone stack (poplar, spruce, cypress): three shrinking
    // cones up the trunk line.
    const top = trunkH + (heightM - trunkH);
    const layers = 3;
    for (let layer = 0; layer < layers; layer++) {
      const f0 = layer / layers;
      const f1 = (layer + 1) / layers;
      const r0 = canopyRadius * (1 - f0 * 0.55);
      const r1 = canopyRadius * (1 - f1 * 0.55);
      const y0 = trunkH * 0.6 + (top - trunkH * 0.6) * f0;
      const y1 = trunkH * 0.6 + (top - trunkH * 0.6) * f1;
      // Open cone frustum between the two rings, built by hand (Cylinder
      // with different radii, open-ended, few segments).
      const frustum = new THREE.CylinderGeometry(r1, r0, y1 - y0, 6, 1, true);
      frustum.translate(0, (y0 + y1) / 2, 0);
      const layerStart = positions.length / 3;
      pushPart(positions, indices, base, frustum);
      for (let i = layerStart; i < positions.length / 3; i++) {
        colors.push(1, 1, 1);
      }
    }
    // Cap the tip.
    const cap = new THREE.ConeGeometry(canopyRadius * 0.45, (top - trunkH * 0.6) / layers, 6);
    cap.translate(0, top + ((top - trunkH * 0.6) / layers) / 2 - 0.05, 0);
    const capStart = positions.length / 3;
    pushPart(positions, indices, base, cap);
    for (let i = capStart; i < positions.length / 3; i++) {
      colors.push(1, 1, 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** Plan distance from a point to a structure ring (for the building keep-out). */
function distToRing(ring: [number, number][], x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[i + 1];
    const dx = bx - ax;
    const dz = bz - az;
    const lenSq = dx * dx + dz * dz;
    const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / lenSq)) : 0;
    const qx = ax + dx * t;
    const qz = az + dz * t;
    const d2 = (x - qx) ** 2 + (z - qz) ** 2;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * Full flora build for a track: per-species geometry (unit size, scaled per
 * instance) plus placed, colored instances. Placement rejects anything on
 * the asphalt (lateral band starts past the edge), on gravel traps (trees
 * grow on grass - checked against the terrain's own paint), outside the
 * terrain field, or inside a mapped building/grandstand/landmark ring.
 */
export function buildFlora(track: TrackData): FloraBuild[] {
  const config = getFloraConfig(track.id);
  if (!config) return [];
  const terrain = buildTerrainGeometry(track);
  const gravel = hexToLinearRgb(GRAVEL_COLOR);
  const n = track.centerline.length;
  const totalWeight = config.species.reduce((a, s) => a + s.weight, 0);

  // Building keep-out rings, projected once (only closed kinds with real
  // volume - fences and lanes are thin or flat, tunnels underground, and a
  // tree touching a fence is natural). Bounding circles reject nearly
  // everything before the exact segment check runs.
  const { centerLon, centerLat } = getStructuresCenter(track.id);
  interface KeepOut {
    ring: [number, number][];
    cx: number;
    cz: number;
    radius: number;
  }
  const keepOuts: KeepOut[] = [];
  for (const s of getStructures(track.id)) {
    if (s.kind !== "building" && s.kind !== "grandstand" && s.kind !== "attraction") continue;
    const ring = s.ring.map(
      ([lon, lat]): [number, number] => {
        const [x, z] = projectToLocal(lon, lat, centerLon, centerLat);
        return [x, z];
      }
    );
    let cx = 0;
    let cz = 0;
    for (const [x, z] of ring) {
      cx += x;
      cz += z;
    }
    cx /= ring.length;
    cz /= ring.length;
    let radius = 0;
    for (const [x, z] of ring) {
      radius = Math.max(radius, Math.hypot(x - cx, z - cz));
    }
    keepOuts.push({ ring, cx, cz, radius });
  }

  const rng = mulberry32(config.seed);
  const targetCount = Math.round((config.densityPerKm * track.lengthMeters) / 1000);
  const perSpecies: FloraInstance[][] = config.species.map(() => []);
  const perColors: string[][] = config.species.map(() => []);

  const maxAttempts = targetCount * 12;
  let placed = 0;
  for (let attempt = 0; attempt < maxAttempts && placed < targetCount; attempt++) {
    const station = rng() * track.lengthMeters;
    const idx = Math.round((station / track.lengthMeters) * n) % n;
    const [cx, , cz] = track.centerline[idx];
    const [px, , pz] = track.centerline[(idx - 1 + n) % n];
    const [nx, , nz] = track.centerline[(idx + 1) % n];
    const tx = nx - px;
    const tz = nz - pz;
    const len = Math.hypot(tx, tz) || 1;
    const side = rng() < 0.5 ? -1 : 1;
    const lateral =
      side * (track.width[idx] / 2 + config.lateralMinM + rng() * (config.lateralMaxM - config.lateralMinM));
    const x = cx + (-tz / len) * lateral;
    const z = cz + (tx / len) * lateral;

    // The lap folds back on itself (hairpins, crossovers), so the sampled
    // station's own arm is not the whole story: verify against the NEAREST
    // arm before planting anything.
    let best = Infinity;
    let bestI = 0;
    for (let i = 0; i < n; i += 2) {
      const dx = track.centerline[i][0] - x;
      const dz = track.centerline[i][2] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bestI = i;
      }
    }
    const [bx, , bz] = track.centerline[bestI];
    const [bpx, , bpz] = track.centerline[(bestI - 1 + n) % n];
    const [bnx, , bnz] = track.centerline[(bestI + 1) % n];
    const btx = bnx - bpx;
    const btz = bnz - bpz;
    const blen = Math.hypot(btx, btz) || 1;
    const nearestLateral = Math.abs(((x - bx) * -btz + (z - bz) * btx) / blen);
    if (nearestLateral < track.width[bestI] / 2 + 8) continue;

    const groundY = sampleTerrainHeight(terrain, x, z);
    if (groundY === null) continue;
    // Inside a mapped building/landmark - canopies poking through roofs
    // read as broken, so these spots stay empty.
    let insideKeepOut = false;
    for (const keep of keepOuts) {
      if (Math.hypot(x - keep.cx, z - keep.cz) > keep.radius + 4) continue;
      if (distToRing(keep.ring, x, z) < 4) {
        insideKeepOut = true;
        break;
      }
    }
    if (insideKeepOut) continue;
    // On gravel, not grass - skip (checked against the terrain paint).
    const column = Math.round((x - terrain.originX) / terrain.cellMeters);
    const row = Math.round((z - terrain.originZ) / terrain.cellMeters);
    const vi = (row * terrain.columns + column) * 3;
    if (
      Math.abs(terrain.colors[vi] - gravel[0]) < 1e-6 &&
      Math.abs(terrain.colors[vi + 1] - gravel[1]) < 1e-6 &&
      Math.abs(terrain.colors[vi + 2] - gravel[2]) < 1e-6
    ) {
      continue;
    }

    // Weighted species pick.
    let pick = rng() * totalWeight;
    let speciesIndex = 0;
    for (let s = 0; s < config.species.length; s++) {
      pick -= config.species[s].weight;
      if (pick <= 0) {
        speciesIndex = s;
        break;
      }
    }
    const species = config.species[speciesIndex];
    const colorIndex = Math.floor(rng() * species.canopyColors.length);
    const scale = 0.8 + rng() * 0.5;
    perSpecies[speciesIndex].push({
      x,
      y: groundY - 0.4,
      z,
      yaw: rng() * Math.PI * 2,
      scale,
      colorIndex,
    });
    perColors[speciesIndex].push(species.canopyColors[colorIndex]);
    placed++;
  }

  return config.species.map((species, s) => {
    const instances = perSpecies[s];
    // Unit geometry at the species' mid size - per-instance scale covers
    // the range (keeps one geometry per species for one draw call).
    const midSize = (species.canopySizeM[0] + species.canopySizeM[1]) / 2;
    const midHeight = (species.heightM[0] + species.heightM[1]) / 2;
    return {
      speciesIndex: s,
      geometry: instances.length > 0 ? buildSpeciesGeometry(species, midSize, midHeight) : new THREE.BufferGeometry(),
      instances,
      colors: perColors[s],
    };
  });
}
