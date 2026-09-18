import { describe, expect, it } from "vitest";
import {
  buildEdgeLineGeometry,
  buildKerbGeometry,
  buildRibbonGeometry,
  EDGE_LINE_WIDTH_METERS,
  GRASS_COLOR,
  GRAVEL_COLOR,
  RIBBON_COLOR,
  hexToLinearRgb,
} from "../lib/tracks/mesh";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import type { TrackData } from "../lib/tracks/types";

function square(width: number): TrackData {
  return {
    id: "square",
    name: "square",
    lengthMeters: 40,
    centerline: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ],
    width: [width, width, width, width],
    startPos: { x: 0, z: 0, headingRad: 0 },
  };
}

describe("buildRibbonGeometry", () => {
  it("produces two vertices and six indices per centerline point", () => {
    const { positions, indices } = buildRibbonGeometry(square(4));
    expect(positions.length).toBe(4 * 2 * 3);
    expect(indices.length).toBe(4 * 6);
  });

  it("offsets left/right vertices by half width, perpendicular to travel", () => {
    const width = 4;
    const { positions } = buildRibbonGeometry(square(width));
    const center = [0, 0, 0];
    const left = [positions[0], positions[1], positions[2]];
    const right = [positions[3], positions[4], positions[5]];

    const distLeft = Math.hypot(left[0] - center[0], left[2] - center[2]);
    const distRight = Math.hypot(right[0] - center[0], right[2] - center[2]);
    expect(distLeft).toBeCloseTo(width / 2);
    expect(distRight).toBeCloseTo(width / 2);

    // Tangent at point 0 (prev=(0,0,10), next=(10,0,0)) runs along (1,-1).
    const tangent = [1, -1];
    const edgeVector = [right[0] - left[0], right[2] - left[2]];
    const dot = edgeVector[0] * tangent[0] + edgeVector[1] * tangent[1];
    expect(dot).toBeCloseTo(0);

    // Left and right straddle the centerline point.
    expect((left[0] + right[0]) / 2).toBeCloseTo(center[0]);
    expect((left[2] + right[2]) / 2).toBeCloseTo(center[2]);
  });

  it("indices stay within the vertex range", () => {
    const { positions, indices } = buildRibbonGeometry(square(4));
    const vertexCount = positions.length / 3;
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(vertexCount);
    }
  });
});

describe("ground surface colors", () => {
  it("keeps the asphalt visibly distinct from the grass", () => {
    // Regression for the "random missing track areas" report: the ribbon
    // rendered everywhere (proven by painting it red), but gray-on-gray
    // grass let sunlit runoff reach ribbon brightness, so every ribbon
    // edge could vanish. The grass is now a real green, so separation is
    // hue as well as luminance: this pins the green dominance plus a
    // luminance ratio floor (measured ~1.27), either of which alone would
    // be a weaker guard than both together.
    const [gr, gg, gb] = hexToLinearRgb(GRASS_COLOR);
    expect(gg).toBeGreaterThan(gr * 1.5);
    expect(gg).toBeGreaterThan(gb * 1.5);
    const luminance = (hex: string): number => {
      const [r, g, b] = hexToLinearRgb(hex);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio =
      (luminance(RIBBON_COLOR) + 0.05) / (luminance(GRASS_COLOR) + 0.05);
    expect(ratio).toBeGreaterThan(1.2);
  });

  it("keeps the gravel tan distinct from the grass", () => {
    const [gr, gg, gb] = hexToLinearRgb(GRAVEL_COLOR);
    // Warm tan: red and green both well above blue.
    expect(gr).toBeGreaterThan(gb * 1.5);
    expect(gg).toBeGreaterThan(gb * 1.5);
  });
});

describe("buildEdgeLineGeometry", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} outlines both asphalt edges with up-facing strips`, () => {
      // The readability half of the "random missing track areas" report:
      // these painted lines are what defines the road where sunlit grass
      // reaches ribbon brightness, so they must exist on both sides of
      // every point, face the camera, and stay on the asphalt.
      const track = getTrack(entry.id);
      const n = track.centerline.length;
      const { positions, indices } = buildEdgeLineGeometry(track);
      expect(positions.length).toBe(n * 4 * 3);
      expect(indices.length).toBe(n * 2 * 6);
      for (let t = 0; t < indices.length; t++) {
        expect(indices[t]).toBeGreaterThanOrEqual(0);
        expect(indices[t]).toBeLessThan(n * 4);
      }
      for (let t = 0; t < indices.length; t += 3) {
        const ax = positions[indices[t] * 3];
        const az = positions[indices[t] * 3 + 2];
        const bx = positions[indices[t + 1] * 3];
        const bz = positions[indices[t + 1] * 3 + 2];
        const cx = positions[indices[t + 2] * 3];
        const cz = positions[indices[t + 2] * 3 + 2];
        expect((bz - az) * (cx - ax) - (bx - ax) * (cz - az)).toBeGreaterThan(0);
      }
      for (let i = 0; i < n; i++) {
        const [x, y, z] = track.centerline[i];
        const halfWidth = track.width[i] / 2;
        for (let k = 0; k < 4; k++) {
          const vx = positions[(i * 4 + k) * 3];
          const vy = positions[(i * 4 + k) * 3 + 1];
          const vz = positions[(i * 4 + k) * 3 + 2];
          // On the asphalt (at most the ribbon edge) and flat at its height
          // - the caller applies the lift, as with the racing line ribbon.
          // The 1e-4 slack is float32 storage rounding of ~1000m
          // coordinates, not geometric tolerance (a tenth of a millimetre).
          expect(Math.hypot(vx - x, vz - z)).toBeLessThanOrEqual(halfWidth + 1e-4);
          expect(vy).toBeCloseTo(y, 5);
          expect(Math.hypot(vx - x, vz - z)).toBeGreaterThanOrEqual(
            halfWidth - EDGE_LINE_WIDTH_METERS - 1e-4
          );
        }
      }
    });
  }
});

describe("buildKerbGeometry", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} winds every kerb triangle facing up, on both sides`, () => {
      // Regression: mirroring a quad across the centerline flips its
      // facing, so one index order cannot serve both runs - the left run
      // used the right run's order and every left kerb faced down,
      // backface-culled from any above-track camera (bare terrain where
      // the stripes should be, reported as track segments missing).
      const { positions, indices } = buildKerbGeometry(getTrack(entry.id));
      expect(indices.length).toBeGreaterThan(0);
      for (let t = 0; t < indices.length; t += 3) {
        // Y of (e1 x e2) for the triangle - positive means facing up.
        const ax = positions[indices[t] * 3];
        const az = positions[indices[t] * 3 + 2];
        const bx = positions[indices[t + 1] * 3];
        const bz = positions[indices[t + 1] * 3 + 2];
        const cx = positions[indices[t + 2] * 3];
        const cz = positions[indices[t + 2] * 3 + 2];
        const normalY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
        expect(normalY).toBeGreaterThan(0);
      }
    });
  }
});
