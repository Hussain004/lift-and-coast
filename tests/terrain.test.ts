import { describe, expect, it } from "vitest";
import {
  TERRAIN_CELL_METERS,
  TERRAIN_OUTER_MARGIN_METERS,
  buildTerrainGeometry,
} from "../lib/tracks/terrain";
import { buildRibbonGeometry, GRASS_BELOW_TRACK_METERS } from "../lib/tracks/mesh";
import { worldEdgeResetMeters } from "../lib/tracks/trackLimits";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import type { TerrainGeometry } from "../lib/tracks/terrain";
import type { TrackData } from "../lib/tracks/types";

function syntheticTrack(centerline: [number, number, number][]): TrackData {
  return {
    id: "synthetic",
    name: "synthetic",
    lengthMeters: centerline.length * 20,
    centerline,
    width: centerline.map(() => 10),
    startPos: { x: centerline[0][0], z: centerline[0][2], headingRad: 0 },
  };
}

/**
 * Height of the built field at a world position, interpolated over the same
 * two triangles per cell the collider is handed (a, down, downRight) and
 * (a, downRight, right). Barycentric rather than the closed-form bilinear
 * split so the test cannot silently disagree with the winding in terrain.ts.
 * Returns null outside the field.
 */
function terrainHeightAt(terrain: TerrainGeometry, x: number, z: number): number | null {
  const column = Math.floor((x - terrain.originX) / terrain.cellMeters);
  const row = Math.floor((z - terrain.originZ) / terrain.cellMeters);
  if (column < 0 || row < 0 || column >= terrain.columns - 1 || row >= terrain.rows - 1) {
    return null;
  }
  const vertex = (c: number, r: number) => {
    const at = (r * terrain.columns + c) * 3;
    return [terrain.positions[at], terrain.positions[at + 1], terrain.positions[at + 2]];
  };
  const a = vertex(column, row);
  const right = vertex(column + 1, row);
  const down = vertex(column, row + 1);
  const downRight = vertex(column + 1, row + 1);
  for (const [p, q, s] of [
    [a, down, downRight],
    [a, downRight, right],
  ]) {
    const denominator = (q[2] - s[2]) * (p[0] - s[0]) + (s[0] - q[0]) * (p[2] - s[2]);
    if (Math.abs(denominator) < 1e-9) continue;
    const l1 = ((q[2] - s[2]) * (x - s[0]) + (s[0] - q[0]) * (z - s[2])) / denominator;
    const l2 = ((s[2] - p[2]) * (x - s[0]) + (p[0] - s[0]) * (z - s[2])) / denominator;
    const l3 = 1 - l1 - l2;
    // Slack covers float32 storage rounding of the stored vertices (about
    // 1e-4m at Monza/Spa's ~1200m coordinates), not just exact-edge samples:
    // both candidate triangles share the edge, so either interpolation agrees
    // there and the slack cannot misattribute a height.
    if (l1 >= -1e-4 && l2 >= -1e-4 && l3 >= -1e-4) {
      return l1 * p[1] + l2 * q[1] + l3 * s[1];
    }
  }
  return null;
}

describe("buildTerrainGeometry (synthetic)", () => {
  it("lays out a square grid that reaches past the world-edge reset radius", () => {
    const track = syntheticTrack([
      [0, 0, 0],
      [0, 0, 20],
    ]);
    const terrain = buildTerrainGeometry(track);
    const half = worldEdgeResetMeters(track) + TERRAIN_OUTER_MARGIN_METERS;

    expect(terrain.cellMeters).toBe(TERRAIN_CELL_METERS);
    expect(terrain.originX).toBe(-half);
    expect(terrain.originZ).toBe(-half);
    expect(terrain.columns).toBe(Math.ceil((half * 2) / TERRAIN_CELL_METERS) + 1);
    expect(terrain.rows).toBe(terrain.columns);
    expect(terrain.positions.length).toBe(terrain.columns * terrain.rows * 3);
    expect(terrain.indices.length).toBe((terrain.columns - 1) * (terrain.rows - 1) * 6);

    // The field has to outlast the reset, or a car can be standing on grass
    // the physics world does not have (the crash the reset exists to avoid).
    const reach = ((terrain.columns - 1) / 2) * terrain.cellMeters;
    expect(reach).toBeGreaterThanOrEqual(worldEdgeResetMeters(track));
  });

  it("gives each vertex the nearest centerline point's height, one hair low", () => {
    // Both points sit on grid lines (the grid is anchored at -half and the
    // cell divides the 20m gap), so these two vertices are exact.
    const track = syntheticTrack([
      [0, 5, 0],
      [0, 15, 20],
    ]);
    const terrain = buildTerrainGeometry(track);
    const heightAtVertex = (c: number, r: number) =>
      terrain.positions[(r * terrain.columns + c) * 3 + 1];
    const column = (0 - terrain.originX) / terrain.cellMeters;
    const row = (0 - terrain.originZ) / terrain.cellMeters;

    expect(heightAtVertex(column, row)).toBeCloseTo(5 - GRASS_BELOW_TRACK_METERS, 4);
    // 12.5m up the field is past the midpoint, so this vertex belongs to the
    // second point (nearest, not interpolated).
    expect(heightAtVertex(column, row + 1)).toBeCloseTo(15 - GRASS_BELOW_TRACK_METERS, 4);
  });

  it("caches the field per track object", () => {
    const track = syntheticTrack([
      [0, 0, 0],
      [0, 0, 20],
    ]);
    expect(buildTerrainGeometry(track)).toBe(buildTerrainGeometry(track));
  });
});

// Relief the field has to reproduce at all: the ground follows the circuit,
// so it is never flat. Loose on purpose - it is here to catch "the field was
// replaced by a plane again", not to re-measure the profile (that is
// tests/trackRegistry.test.ts).
const MIN_TERRAIN_RELIEF: Record<string, number> = {
  silverstone: 5,
  monza: 10,
  spa: 50,
  suzuka: 20,
  monaco: 20,
};

// How far the field may dip under the ribbon at an edge sample. The
// clearance pass the test above pins down pushes overlapping terrain until
// it clears the asphalt, and at Monaco the lap's arms genuinely differ in
// height inside one 12.5m cell (the climb, the hairpin fold) - that
// difference has to go somewhere, and below the ribbon, as a grass bank
// beside the track the module doc already expects there, is the side that
// hides no asphalt.
const MAX_TERRAIN_DIP_METERS: Record<string, number> = {
  silverstone: 0.5,
  monza: 0.5,
  spa: 0.5,
  suzuka: 0.5,
  monaco: 0.75,
};

describe("buildTerrainGeometry (real circuits)", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} follows the circuit's elevation`, () => {
      const terrain = buildTerrainGeometry(getTrack(entry.id));
      let min = Infinity;
      let max = -Infinity;
      for (let i = 1; i < terrain.positions.length; i += 3) {
        min = Math.min(min, terrain.positions[i]);
        max = Math.max(max, terrain.positions[i]);
      }
      expect(max - min).toBeGreaterThan(MIN_TERRAIN_RELIEF[entry.id]);
    });

    it(`${entry.id} keeps terrain below the whole asphalt surface`, () => {
      const track = getTrack(entry.id);
      const terrain = buildTerrainGeometry(track);
      const ribbon = buildRibbonGeometry(track);
      let worst = -Infinity;
      let hidden = 0;
      let samples = 0;
      let downward = 0;
      for (let t = 0; t < ribbon.indices.length; t += 3) {
        const vertices = Array.from(ribbon.indices.slice(t, t + 3), (i) =>
          Array.from(ribbon.positions.slice(i * 3, i * 3 + 3))
        );
        const [a, b, c] = vertices;
        const normalY = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
        if (normalY < 0) downward++;
        // Independent barycentric samples across each road triangle, including
        // both edges and interior (the old edge-only 0.5m tolerance hid this).
        for (let u = 0; u <= 8; u++) {
          for (let v = 0; v <= 8 - u; v++) {
            const p = a.map((value, axis) =>
              value + (b[axis] - value) * u / 8 + (c[axis] - value) * v / 8
            );
            const ground = terrainHeightAt(terrain, p[0], p[2]);
            expect(ground).not.toBeNull();
            const difference = ground! - p[1];
            worst = Math.max(worst, difference);
            if (difference >= 0) hidden++;
            samples++;
          }
        }
      }
      console.info(`${entry.id}: terrain intrusion ${worst.toFixed(4)}m, ${hidden}/${samples} covered samples, ${downward} downward road triangles`);
      expect(worst).toBeLessThanOrEqual(-GRASS_BELOW_TRACK_METERS + 0.0001);
    });

    it(`${entry.id} meets the ribbon at its edges, from below`, () => {
      // The invariant the whole height field exists for: a wheel on the
      // painted surface must never find ground above it, and the ground has
      // to be *there* rather than a hole. Both are checked at the ribbon
      // edges, where a nearest-point field is furthest from flush. The
      // tolerance is the field's own resolution: measured worst is 0.16m of
      // rise (Spa) and 0.02m of deviation on average, so this catches a
      // field that has drifted off the circuit's elevation without being
      // brittle about the 12.5m cells.
      const track = getTrack(entry.id);
      const terrain = buildTerrainGeometry(track);
      const line = track.centerline;
      const n = line.length;
      let worstAbove = -Infinity;
      let worstAboveIndex = 0;
      let worstBelow = Infinity;
      let worstBelowIndex = 0;
      let total = 0;
      let samples = 0;
      for (let i = 0; i < n; i++) {
        const [x, y, z] = line[i];
        const [px, , pz] = line[(i - 1 + n) % n];
        const [nx, , nz] = line[(i + 1) % n];
        const tangentX = nx - px;
        const tangentZ = nz - pz;
        const length = Math.hypot(tangentX, tangentZ) || 1;
        const halfWidth = track.width[i] / 2;
        for (const side of [-1, 1]) {
          const edgeX = x + (-tangentZ / length) * halfWidth * side;
          const edgeZ = z + (tangentX / length) * halfWidth * side;
          const ground = terrainHeightAt(terrain, edgeX, edgeZ);
          if (ground === null) continue;
          const deviation = ground - y;
          total += Math.abs(deviation);
          samples++;
          if (deviation > worstAbove) {
            worstAbove = deviation;
            worstAboveIndex = i;
          }
          if (deviation < worstBelow) {
            worstBelow = deviation;
            worstBelowIndex = i;
          }
        }
      }
      expect(samples).toBe(n * 2);
      expect(
        worstAbove,
        `terrain pokes ${worstAbove.toFixed(2)}m above the ribbon at centerline index ${worstAboveIndex}`
      ).toBeLessThan(0.5);
      expect(worstBelow, `terrain dips ${worstBelow.toFixed(2)}m under the ribbon at centerline index ${worstBelowIndex}`).toBeGreaterThan(
        -MAX_TERRAIN_DIP_METERS[entry.id]
      );
      expect(total / samples).toBeLessThan(0.1);
    });
  }
});
