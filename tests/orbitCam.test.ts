import { describe, expect, it } from "vitest";
import {
  ORBIT_MAX_PITCH,
  ORBIT_MAX_RADIUS,
  ORBIT_MIN_PITCH,
  ORBIT_MIN_RADIUS,
  anchorOrbit,
  clampOrbit,
  orbitPosition,
} from "../lib/race/orbitCam";

describe("orbitCam", () => {
  it("anchors behind and above the car", () => {
    // Facing -Z at yaw 0 (see lib/tracks/minimap.ts): behind is +Z.
    const o = anchorOrbit(10, 2, 30, 0);
    expect(o.ax).toBe(10);
    expect(o.az).toBe(30);
    const p = orbitPosition(o);
    expect(p.x).toBeCloseTo(10, 9);
    expect(p.z).toBeGreaterThan(30);
    expect(p.y).toBeGreaterThan(2);
  });

  it("clamps pitch and radius instead of flipping or escaping", () => {
    const o = clampOrbit({ ax: 0, ay: 0, az: 0, yaw: 0, pitch: 99, radius: -5 });
    expect(o.pitch).toBe(ORBIT_MAX_PITCH);
    expect(o.radius).toBe(ORBIT_MIN_RADIUS);
    expect(
      clampOrbit({ ax: 0, ay: 0, az: 0, yaw: 0, pitch: -99, radius: 10 }).pitch
    ).toBe(ORBIT_MIN_PITCH);
    const p = orbitPosition({ ax: 0, ay: 0, az: 0, yaw: 0, pitch: 99, radius: 1e9 });
    expect(p.y).toBeLessThan(ORBIT_MAX_RADIUS + 1);
  });

  it("is deterministic per state", () => {
    const o = anchorOrbit(1, 2, 3, 0.7);
    expect(orbitPosition(o)).toEqual(orbitPosition({ ...o }));
  });
});
