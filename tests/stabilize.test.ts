import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { computeStabilizingTorque } from "../lib/physics/vehicle";

describe("computeStabilizingTorque", () => {
  it("returns zero torque when upright", () => {
    const torque = computeStabilizingTorque({ x: 0, y: 0, z: 0, w: 1 }, 10);
    expect(torque).toEqual([0, 0, 0]);
  });

  it("returns zero torque below the tilt threshold", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.01);
    const torque = computeStabilizingTorque(q, 10);
    expect(torque).toEqual([0, 0, 0]);
  });

  it("points the car back toward upright when tilted", () => {
    const q = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.3);
    const [tx, ty, tz] = computeStabilizingTorque(q, 1);
    const axis = new Vector3(tx, ty, tz);
    const magnitude = axis.length();
    expect(magnitude).toBeGreaterThan(0);
    axis.normalize();

    const nudged = new Quaternion()
      .setFromAxisAngle(axis, 0.01)
      .multiply(q);
    const worldUp = new Vector3(0, 1, 0);
    const tiltBefore = new Vector3(0, 1, 0).applyQuaternion(q).angleTo(worldUp);
    const tiltAfter = new Vector3(0, 1, 0)
      .applyQuaternion(nudged)
      .angleTo(worldUp);
    expect(tiltAfter).toBeLessThan(tiltBefore);
  });

  it("scales with tilt angle", () => {
    const small = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.1);
    const large = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.5);
    const smallTorque = new Vector3(...computeStabilizingTorque(small, 1));
    const largeTorque = new Vector3(...computeStabilizingTorque(large, 1));
    expect(largeTorque.length()).toBeGreaterThan(smallTorque.length());
  });
});
