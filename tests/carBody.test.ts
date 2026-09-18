import { describe, expect, it } from "vitest";
import { CHASSIS_HALF_EXTENTS, CAR_WHEELS } from "../lib/physics/vehicle";
import {
  FLAP_OPEN_RAD,
  computeF1BodyPanels,
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
