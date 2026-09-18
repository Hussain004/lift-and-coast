import { describe, expect, it } from "vitest";
import { computeDriverFigure } from "../lib/race/driverFigure";

function build() {
  return computeDriverFigure();
}

describe("computeDriverFigure", () => {
  it("emits finite panels with real volume", () => {
    const { panels, helmet } = build();
    expect(panels.length).toBeGreaterThan(10);
    for (const p of panels) {
      for (const v of [...p.size, ...p.position]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(p.size.every((s) => s > 0)).toBe(true);
    }
    expect(helmet.radius).toBeGreaterThan(0);
    expect(helmet.position.every(Number.isFinite)).toBe(true);
  });

  it("stands on the ground plane at human scale", () => {
    const { panels, helmet } = build();
    const bottoms = panels.map((p) => p.position[1] - p.size[1] / 2);
    const tops = panels.map((p) => p.position[1] + p.size[1] / 2);
    expect(Math.min(...bottoms)).toBeCloseTo(0, 9);
    expect(Math.max(...tops, helmet.position[1] + helmet.radius)).toBeLessThan(1.9);
    for (const p of panels) {
      expect(Math.abs(p.position[0]) + p.size[0] / 2).toBeLessThanOrEqual(0.5);
      expect(Math.abs(p.position[2]) + p.size[2] / 2).toBeLessThanOrEqual(0.3);
    }
  });

  it("mirrors every off-center panel across the spine", () => {
    const { panels } = build();
    const used = new Array(panels.length).fill(false);
    for (let i = 0; i < panels.length; i++) {
      if (used[i]) continue;
      const a = panels[i];
      if (Math.abs(a.position[0]) < 1e-9) continue;
      const j = panels.findIndex(
        (b, k) =>
          !used[k] &&
          k !== i &&
          b.color === a.color &&
          b.size.every((s, axis) => Math.abs(s - a.size[axis]) < 1e-9) &&
          Math.abs(b.position[0] + a.position[0]) < 1e-9 &&
          Math.abs(b.position[1] - a.position[1]) < 1e-9 &&
          Math.abs(b.position[2] - a.position[2]) < 1e-9
      );
      expect(j, `no mirror for panel ${i}`).toBeGreaterThanOrEqual(0);
      used[i] = true;
      used[j] = true;
    }
  });

  it("dresses suit, trim, helmet and visor roles", () => {
    const { panels } = build();
    const colors = new Set(panels.map((p) => p.color));
    for (const role of ["suit", "trim", "carbon", "visor"] as const) {
      expect(colors.has(role)).toBe(true);
    }
  });
});
