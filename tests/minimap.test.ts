import { describe, expect, it } from "vitest";
import { MINIMAP_SIZE_PX, buildMinimapPath, projectToMinimap } from "../lib/tracks/minimap";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

describe("buildMinimapPath", () => {
  it("produces a closed SVG path in raw world meters referencing every centerline point", () => {
    const pathD = buildMinimapPath(track);
    expect(pathD.startsWith("M")).toBe(true);
    expect(pathD.endsWith("Z")).toBe(true);
    expect(pathD.split("L").length - 1).toBe(track.centerline.length - 1);
  });
});

const SAMPLE_YAWS = [0, Math.PI / 2, Math.PI, -1.234, 2.9];

describe("projectToMinimap orientation (car-centered, forward-up rotation)", () => {
  it.each(SAMPLE_YAWS)("keeps the car's own position at the box center regardless of yaw (yaw=%f)", (yaw) => {
    const carX = 10;
    const carZ = -20;
    const p = projectToMinimap(carX, carZ, carX, carZ, yaw);
    expect(p.x).toBeCloseTo(MINIMAP_SIZE_PX / 2, 5);
    expect(p.y).toBeCloseTo(MINIMAP_SIZE_PX / 2, 5);
  });

  it.each(SAMPLE_YAWS)(
    "projects a point straight ahead of the car (its own forward direction) directly above center (yaw=%f)",
    (yaw) => {
      const carX = 5;
      const carZ = 5;
      // Same forward convention as vehicle.ts's yawFromQuaternion / CAR_WHEELS:
      // forward is -Z at yaw 0.
      const forwardX = -Math.sin(yaw);
      const forwardZ = -Math.cos(yaw);
      const aheadX = carX + forwardX * 20;
      const aheadZ = carZ + forwardZ * 20;
      const p = projectToMinimap(aheadX, aheadZ, carX, carZ, yaw);
      expect(p.x).toBeCloseTo(MINIMAP_SIZE_PX / 2, 3);
      expect(p.y).toBeLessThan(MINIMAP_SIZE_PX / 2 - 1);
    }
  );

  it.each(SAMPLE_YAWS)("projects a point directly behind the car below center (yaw=%f)", (yaw) => {
    const carX = -3;
    const carZ = 8;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const behindX = carX - forwardX * 20;
    const behindZ = carZ - forwardZ * 20;
    const p = projectToMinimap(behindX, behindZ, carX, carZ, yaw);
    expect(p.x).toBeCloseTo(MINIMAP_SIZE_PX / 2, 3);
    expect(p.y).toBeGreaterThan(MINIMAP_SIZE_PX / 2 + 1);
  });
});
