import { describe, expect, it } from "vitest";
import {
  QUALITY_SETTINGS,
  isSoftwareRenderer,
  nextGraphicsPref,
  parseGraphicsPref,
  pickAutoQuality,
  stepDownQuality,
} from "../lib/render/quality";
import { chunkMesh, chunkPoints, thin } from "../lib/render/chunks";

describe("graphics quality", () => {
  it("sends software rasterizers straight to low, real GPUs to medium", () => {
    for (const r of [
      "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)",
      "llvmpipe (LLVM 15.0.7, 256 bits)",
      "Microsoft Basic Render Driver",
    ]) {
      expect(isSoftwareRenderer(r)).toBe(true);
      expect(pickAutoQuality({ renderer: r })).toBe("low");
    }
    expect(pickAutoQuality({ renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)" })).toBe("medium");
    expect(pickAutoQuality({ renderer: "" })).toBe("medium");
  });

  it("orders the tiers by cost", () => {
    const { low, medium, high } = QUALITY_SETTINGS;
    expect(low.maxDpr).toBeLessThan(medium.maxDpr);
    expect(medium.maxDpr).toBeLessThan(high.maxDpr);
    expect(low.shadows).toBe(false);
    expect(low.cheapMaterials).toBe(true);
    expect(low.floraDensity).toBeLessThan(high.floraDensity);
    for (const tier of [low, medium, high]) expect(tier.minDpr).toBeLessThanOrEqual(tier.maxDpr);
  });

  it("steps down to low and no further; cycles preferences; parses junk as auto", () => {
    expect(stepDownQuality("high")).toBe("medium");
    expect(stepDownQuality("medium")).toBe("low");
    expect(stepDownQuality("low")).toBe("low");
    expect(nextGraphicsPref("auto")).toBe("low");
    expect(nextGraphicsPref("high")).toBe("auto");
    expect(parseGraphicsPref("ultra")).toBe("auto");
    expect(parseGraphicsPref(null)).toBe("auto");
  });
});

describe("chunking", () => {
  it("splits a mesh by cell without losing or duplicating a triangle", () => {
    // Two quads 1km apart, each two triangles, with per-vertex colors.
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 10,
      1000, 0, 0, 1010, 0, 0, 1010, 0, 10, 1000, 0, 10,
    ]);
    const colors = new Float32Array(positions.length).map((_, i) => i / positions.length);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const chunks = chunkMesh({ positions, indices, colors }, 180);
    expect(chunks).toHaveLength(2);
    expect(chunks.reduce((sum, c) => sum + c.indices.length, 0)).toBe(indices.length);
    for (const chunk of chunks) {
      expect(chunk.positions.length).toBe(12);
      expect(chunk.colors?.length).toBe(12);
      for (const i of chunk.indices) expect(i).toBeLessThan(4);
    }
    // Vertex data travels with its triangle.
    const far = chunks.find((c) => c.positions[0] >= 1000)!;
    expect(far.colors![0]).toBeCloseTo(colors[12], 6);
  });

  it("groups points by cell and thins evenly and stably", () => {
    const points = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) * 50, z: Math.floor(i / 20) * 50, id: i }));
    const cells = chunkPoints(points, 180);
    expect(cells.flat()).toHaveLength(200);
    const half = thin(points, 0.5);
    expect(half.length).toBeGreaterThan(90);
    expect(half.length).toBeLessThan(110);
    expect(thin(points, 0.5).map((p) => p.id)).toEqual(half.map((p) => p.id));
    // Spread across the list, not the first N.
    expect(half.some((p) => p.id > 150)).toBe(true);
    expect(thin(points, 1)).toHaveLength(200);
  });
});
