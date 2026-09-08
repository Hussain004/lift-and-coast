import { describe, expect, it } from "vitest";
import { buildRibbonGeometry } from "../lib/tracks/mesh";
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
