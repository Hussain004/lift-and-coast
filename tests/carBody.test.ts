import { describe, expect, it } from "vitest";
import { CHASSIS_HALF_EXTENTS, CAR_WHEELS } from "../lib/physics/vehicle";
import {
  DEFAULT_ACCENT_COLOR,
  FLAP_CLOSED_INCLINE_RAD,
  FLAP_OPEN_RAD,
  computeAccentColor,
  computeF1BodyPanels,
  mergePanelBoxes,
  stepFlapAngle,
} from "../lib/race/carBody";

const [HX, , HZ] = CHASSIS_HALF_EXTENTS;
const stations = CAR_WHEELS.map((w) => ({ x: w.position[0], z: w.position[2] }));
const TIRE_HALF_WIDTH = 0.14;
const TIRE_RADIUS = 0.34;
const TIRE_CENTER_Y = -0.35;

function build() {
  return computeF1BodyPanels(CHASSIS_HALF_EXTENTS, stations);
}

describe("computeF1BodyPanels", () => {
  it("emits finite panels in livery and carbon at least", () => {
    const { panels, helmet, halo } = build();
    expect(panels.length).toBeGreaterThan(20);
    for (const p of panels) {
      for (const v of [...p.size, ...p.position]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).not.toBeNaN();
      }
      expect(p.size.every((s) => s > 0)).toBe(true);
    }
    expect(Number.isFinite(helmet.radius + halo.radius + halo.tube)).toBe(true);
    const colors = new Set(panels.map((p) => p.color));
    expect(colors.has("livery")).toBe(true);
    expect(colors.has("carbon")).toBe(true);
  });

  it("stays inside the collider envelope plus wing overhang", () => {
    const { panels } = build();
    for (const p of panels) {
      const [sx, sy, sz] = p.size;
      const [x, y, z] = p.position;
      expect(Math.abs(x) + sx / 2).toBeLessThanOrEqual(HX + 0.15);
      expect(y - sy / 2).toBeGreaterThanOrEqual(-0.45);
      expect(y + sy / 2).toBeLessThanOrEqual(0.95);
      expect(z - sz / 2).toBeGreaterThanOrEqual(-(HZ + 0.3));
      expect(z + sz / 2).toBeLessThanOrEqual(HZ + 0.1);
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

  it("reaches every wheel station with arms from the bodywork", () => {
    const { panels } = build();
    for (const { x, z } of stations) {
      const side = x < 0 ? -1 : 1;
      const atStation = panels.filter((p) => Math.abs(p.position[2] - z) < 0.05);
      expect(atStation.length).toBeGreaterThanOrEqual(2);
      let inboard = Infinity;
      let outboard = -Infinity;
      for (const p of atStation) {
        // Edges measured from the spine outward on this side.
        const near = side * p.position[0] - p.size[0] / 2;
        const far = side * p.position[0] + p.size[0] / 2;
        inboard = Math.min(inboard, near);
        outboard = Math.max(outboard, far);
      }
      // Some arm starts inside the bodywork and ends inside the tire
      // (inner sidewall at 0.68m out).
      expect(inboard).toBeLessThanOrEqual(0.5);
      expect(outboard).toBeGreaterThanOrEqual(0.65);
    }
  });

  it("keeps bodywork out of the tire cylinders (arms only touch)", () => {
    const { panels } = build();
    for (const { x: sx, z: wz } of stations) {
      const side = sx < 0 ? -1 : 1;
      const box = {
        x0: sx - side * TIRE_HALF_WIDTH,
        x1: sx + side * TIRE_HALF_WIDTH,
        y0: TIRE_CENTER_Y - TIRE_RADIUS,
        y1: TIRE_CENTER_Y + TIRE_RADIUS,
        z0: wz - TIRE_RADIUS,
        z1: wz + TIRE_RADIUS,
      };
      // Normalize to min/max regardless of side.
      const [bx0, bx1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1)];
      for (const p of panels) {
        const [w, h, d] = p.size;
        const [x, y, z] = p.position;
        const ox = Math.max(0, Math.min(x + w / 2, bx1) - Math.max(x - w / 2, bx0));
        const oy = Math.max(0, Math.min(y + h / 2, box.y1) - Math.max(y - h / 2, box.y0));
        const oz = Math.max(0, Math.min(z + d / 2, box.z1) - Math.max(z - d / 2, box.z0));
        // Suspension tips intentionally land in the sidewalls; anything
        // bigger is a floor or wing clipping a wheel.
        expect(ox * oy * oz).toBeLessThan(0.002);
      }
    }
  });

  it("seats the helmet in the cockpit ringed by the halo", () => {
    const { helmet, halo } = build();
    expect(helmet.radius).toBeGreaterThan(0);
    expect(halo.radius).toBeGreaterThan(helmet.radius);
    expect(halo.position[0]).toBeCloseTo(helmet.position[0], 9);
    expect(halo.position[2]).toBeCloseTo(helmet.position[2], 9);
    // Helmet crown pokes above the ring, visor height inside it.
    expect(helmet.position[1] + helmet.radius).toBeGreaterThan(
      halo.position[1] + halo.tube
    );
  });

  it("marks exactly the rear-wing plane as the moving flap", () => {
    const { panels } = build();
    const flaps = panels.filter((p) => p.flap);
    expect(flaps.length).toBe(1);
    // Top rear, spanning most of the wing width.
    expect(flaps[0].position[1]).toBeGreaterThan(0.5);
    expect(flaps[0].position[2]).toBeGreaterThan(1.5);
    expect(flaps[0].size[0]).toBeGreaterThan(1.2);
  });

  it("steps the flap without overshoot and tolerates bad dt", () => {
    expect(FLAP_OPEN_RAD).toBeLessThan(0);
    expect(stepFlapAngle(0, FLAP_OPEN_RAD, 0)).toBe(0);
    expect(stepFlapAngle(0, FLAP_OPEN_RAD, -1)).toBe(0);
    // Snaps fully open within a quarter second, then holds.
    expect(stepFlapAngle(0, FLAP_OPEN_RAD, 1)).toBe(FLAP_OPEN_RAD);
    expect(stepFlapAngle(FLAP_OPEN_RAD, FLAP_OPEN_RAD, 1)).toBe(FLAP_OPEN_RAD);
    // Partial step moves toward the target without passing it.
    const mid = stepFlapAngle(0, FLAP_OPEN_RAD, 0.05);
    expect(mid).toBeLessThan(0);
    expect(mid).toBeGreaterThan(FLAP_OPEN_RAD);
    expect(stepFlapAngle(FLAP_OPEN_RAD, 0, 1)).toBe(0);
  });
});

describe("premium body assembly", () => {
  it("builds the rear wing as a two-element assembly between endplates", () => {
    const { panels } = build();
    // Wing elements are the wide centered panels out at the tail: the static
    // main plane and the one moving flap above it.
    const elements = panels.filter(
      (p) => Math.abs(p.position[0]) < 1e-9 && p.position[2] > 1.5 && p.size[0] > 1.2
    );
    const flaps = elements.filter((p) => p.flap);
    const mains = elements.filter((p) => !p.flap);
    expect(flaps.length).toBe(1);
    expect(mains.length).toBeGreaterThanOrEqual(1);
    const flap = flaps[0];
    const main = mains.reduce(
      (lowest, panel) => (panel.position[1] < lowest.position[1] ? panel : lowest),
      mains[0]
    );
    expect(flap.position[1]).toBeGreaterThan(main.position[1]);
    // Same station, so the flap sweeps in the plane the main plane defines.
    expect(Math.abs(flap.position[2] - main.position[2])).toBeLessThan(0.2);
    // Endplates flank the wing and are set wider apart than the flap is.
    const endplates = panels.filter((p) => p.position[2] > 1.5 && Math.abs(p.position[0]) > 0.7);
    expect(endplates.length).toBeGreaterThanOrEqual(2);
    const innerFace = Math.min(
      ...endplates.map((p) => Math.abs(p.position[0]) - p.size[0] / 2)
    );
    expect(flap.size[0] / 2).toBeLessThan(innerFace);
  });

  it("parks the DRS flap at an angle of attack and opens further from it", () => {
    expect(FLAP_CLOSED_INCLINE_RAD).toBeLessThan(0);
    const deployed = FLAP_CLOSED_INCLINE_RAD + FLAP_OPEN_RAD;
    // Opens past the park angle without folding flat over the wing: about
    // 49 degrees of travel for the deployed flap.
    expect(deployed).toBeLessThan(FLAP_CLOSED_INCLINE_RAD);
    expect(deployed).toBeGreaterThan(-1.3);
  });

  it("deploys the flap in about a quarter second of frames", () => {
    let angle = 0;
    for (let frame = 0; frame < 15; frame++) {
      const next = stepFlapAngle(angle, FLAP_OPEN_RAD, 1 / 60);
      expect(next).toBeLessThanOrEqual(angle);
      expect(next).toBeGreaterThanOrEqual(FLAP_OPEN_RAD);
      angle = next;
    }
    expect(angle).toBeCloseTo(FLAP_OPEN_RAD, 9);
  });

  it("paints livery stripes in a second color", () => {
    const { panels } = build();
    expect(panels.some((p) => p.color === "accent")).toBe(true);
  });

  it("derives a readable accent from a single-paint livery", () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    for (const paint of ["#0d2c5c", "#ff2800", "#00a19b", "#d9d9d9", "#8f959c"]) {
      const accent = computeAccentColor(paint);
      expect(accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(Math.abs(luminance(accent) - luminance(paint))).toBeGreaterThan(0.15);
    }
    // Dark paints lighten, very light paints darken.
    expect(luminance(computeAccentColor("#0d2c5c"))).toBeGreaterThan(luminance("#0d2c5c"));
    expect(luminance(computeAccentColor("#ffffff"))).toBeLessThan(luminance("#ffffff"));
    // Shorthand hex works; junk falls back instead of throwing.
    expect(computeAccentColor("#abc")).toMatch(/^#[0-9a-f]{6}$/);
    expect(computeAccentColor("not-a-color")).toBe(DEFAULT_ACCENT_COLOR);
    expect(computeAccentColor("")).toBe(DEFAULT_ACCENT_COLOR);
  });
});

describe("mergePanelBoxes", () => {
  it("emits one box per panel with outward-facing winding", () => {
    const { panels } = build();
    const boxes = panels.filter((p) => !p.flap);
    const { positions, normals, indices } = mergePanelBoxes(boxes);
    expect(positions.length).toBe(boxes.length * 24 * 3);
    expect(normals.length).toBe(boxes.length * 24 * 3);
    expect(indices.length).toBe(boxes.length * 36);
    // Uint16 index headroom (see the bounds comment in carBody.ts).
    expect(indices.length).toBeGreaterThan(0);
    const vertices = positions.length / 3;
    expect(vertices).toBeLessThan(65536);
    for (let i = 0; i < indices.length; i++) {
      expect(indices[i]).toBeLessThan(vertices);
    }
    // Every triangle's geometric normal (from its winding) must match the
    // normal stored on its vertices - which is what proves the faces are
    // wound front-facing and point outward.
    const at = (i: number) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t];
      const [p0, p1, p2] = [at(a), at(indices[t + 1]), at(indices[t + 2])];
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
      const v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const length = Math.hypot(n[0], n[1], n[2]);
      expect(length).toBeGreaterThan(1e-9);
      const stored = [normals[a * 3], normals[a * 3 + 1], normals[a * 3 + 2]];
      expect(Math.hypot(stored[0], stored[1], stored[2])).toBeCloseTo(1, 9);
      for (let axis = 0; axis < 3; axis++) {
        expect(Math.abs(n[axis] / length - stored[axis])).toBeLessThan(1e-6);
      }
    }
  });

  it("spans exactly the panels' bounds and repeats itself exactly", () => {
    const { panels } = build();
    const boxes = panels.filter((p) => !p.flap);
    const first = mergePanelBoxes(boxes);
    const second = mergePanelBoxes(boxes);
    expect(first.positions).toEqual(second.positions);
    expect(first.normals).toEqual(second.normals);
    expect(first.indices).toEqual(second.indices);
    for (let axis = 0; axis < 3; axis++) {
      let min = Infinity;
      let max = -Infinity;
      for (const panel of boxes) {
        min = Math.min(min, panel.position[axis] - panel.size[axis] / 2);
        max = Math.max(max, panel.position[axis] + panel.size[axis] / 2);
      }
      for (let i = 0; i < first.positions.length; i += 3) {
        expect(first.positions[i + axis]).toBeGreaterThanOrEqual(min - 1e-9);
        expect(first.positions[i + axis]).toBeLessThanOrEqual(max + 1e-9);
      }
      let seenMin = Infinity;
      let seenMax = -Infinity;
      for (let i = 0; i < first.positions.length; i += 3) {
        seenMin = Math.min(seenMin, first.positions[i + axis]);
        seenMax = Math.max(seenMax, first.positions[i + axis]);
      }
      // Float32 buffers vs float64 expectations: a float32 ulp at a few
      // meters is ~2e-7, so compare with headroom rather than exactly.
      expect(Math.abs(seenMin - min)).toBeLessThan(1e-5);
      expect(Math.abs(seenMax - max)).toBeLessThan(1e-5);
    }
  });

  it("handles an empty group without emitting anything", () => {
    const merged = mergePanelBoxes([]);
    expect(merged.positions.length).toBe(0);
    expect(merged.normals.length).toBe(0);
    expect(merged.indices.length).toBe(0);
  });
});
