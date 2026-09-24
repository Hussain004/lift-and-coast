import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { CAR_WHEELS, CHASSIS_HALF_EXTENTS } from "../lib/physics/vehicle";
import {
  DEFAULT_ACCENT_COLOR,
  FLAP_CLOSED_INCLINE_RAD,
  FLAP_OPEN_RAD,
  computeAccentColor,
  stepFlapAngle,
} from "../lib/race/carBody";
import {
  COMPOUND_STRIPE_COLOR,
  FLAP_PIVOT,
  FLAP_SPAN,
  TIRE_WIDTH,
  WHEEL_RADIUS,
  buildCarGeometry,
  buildWheelGeometry,
} from "../lib/race/carSculpt";

const [HX, , HZ] = CHASSIS_HALF_EXTENTS;
const car = buildCarGeometry("#0d2c5c", "#ff5aa0");

function box(geometry: THREE.BufferGeometry): THREE.Box3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox!;
}

describe("sculpted car", () => {
  it("stays inside the collider envelope plus wing overhang", () => {
    for (const g of [car.paint, car.carbon]) {
      const b = box(g);
      expect(Math.max(-b.min.x, b.max.x)).toBeLessThanOrEqual(HX + 0.15);
      expect(b.min.y).toBeGreaterThanOrEqual(-0.45);
      expect(b.max.y).toBeLessThanOrEqual(0.95);
      expect(b.min.z).toBeGreaterThanOrEqual(-(HZ + 0.3));
      expect(b.max.z).toBeLessThanOrEqual(HZ + 0.15);
    }
  });

  it("is mirror-symmetric across the spine", () => {
    for (const g of [car.paint, car.carbon]) {
      const b = box(g);
      expect(b.min.x).toBeCloseTo(-b.max.x, 3);
    }
  });

  it("keeps the painted bodywork out of the tyres", () => {
    const pos = car.paint.getAttribute("position");
    for (const w of CAR_WHEELS) {
      const [wx, wy, wz] = w.position;
      for (let i = 0; i < pos.count; i++) {
        const insideWidth = Math.abs(pos.getX(i) - wx) < TIRE_WIDTH / 2;
        const insideRadius = Math.hypot(pos.getY(i) - wy, pos.getZ(i) - wz) < WHEEL_RADIUS;
        expect(insideWidth && insideRadius).toBe(false);
      }
    }
  });

  it("fits the active-aero flap between the rear endplates, behind the main plane", () => {
    expect(FLAP_SPAN / 2).toBeLessThan(0.72);
    expect(FLAP_PIVOT[2]).toBeGreaterThan(1.5);
    const b = box(car.flap);
    expect(b.min.z).toBeGreaterThanOrEqual(-1e-6);
    expect(b.max.x).toBeCloseTo(FLAP_SPAN / 2, 3);
  });

  it("carries vertex colours and stays inside a draw budget", () => {
    for (const g of [car.paint, car.carbon, car.flap]) {
      expect(g.getAttribute("color")).toBeDefined();
      expect(g.getAttribute("normal")).toBeDefined();
    }
    const triangles = (car.paint.getAttribute("position").count + car.carbon.getAttribute("position").count) / 3;
    expect(triangles).toBeLessThan(12000);
    // Livery paint really is on the paint mesh.
    const colors = car.paint.getAttribute("color");
    const livery = new THREE.Color("#0d2c5c");
    let found = false;
    for (let i = 0; i < colors.count && !found; i++) {
      found = Math.abs(colors.getX(i) - livery.r) < 1e-3 && Math.abs(colors.getZ(i) - livery.b) < 1e-3;
    }
    expect(found).toBe(true);
  });

  it("paints each compound's sidewall stripe in its own colour", () => {
    const hasColor = (g: THREE.BufferGeometry, hex: string): boolean => {
      const c = new THREE.Color(hex);
      const colors = g.getAttribute("color");
      for (let i = 0; i < colors.count; i++) {
        if (Math.abs(colors.getX(i) - c.r) + Math.abs(colors.getY(i) - c.g) + Math.abs(colors.getZ(i) - c.b) < 1e-3) return true;
      }
      return false;
    };
    for (const compound of ["soft", "medium", "hard"] as const) {
      const wheel = buildWheelGeometry(COMPOUND_STRIPE_COLOR[compound]);
      expect(hasColor(wheel, COMPOUND_STRIPE_COLOR[compound])).toBe(true);
    }
    expect(new Set(Object.values(COMPOUND_STRIPE_COLOR)).size).toBe(3);
  });

  it("builds a wheel on the physics radius with its axle along x", () => {
    const b = box(buildWheelGeometry());
    expect(b.max.y).toBeCloseTo(WHEEL_RADIUS, 2);
    expect(b.max.z).toBeCloseTo(WHEEL_RADIUS, 2);
    expect(b.max.x).toBeLessThan(TIRE_WIDTH / 2 + 0.02);
  });
});

describe("active-aero flap and livery", () => {
  it("parks the active-aero flap at an angle of attack and opens further from it", () => {
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
