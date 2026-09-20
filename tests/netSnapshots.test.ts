import { describe, expect, it } from "vitest";
import { pushSnapshot, renderTimestamp, samplePose, INTERP_DELAY_MS, type TimedSnapshot, type CarPose } from "../lib/net/snapshots";

const pose = (x: number): CarPose => ({
  position: [x, 0, 0],
  rotation: [0, 0, 0, 1],
  linvel: [10, 0, 0],
});

describe("pushSnapshot", () => {
  it("drops samples older than the TTL", () => {
    const buffer: TimedSnapshot<CarPose>[] = [];
    pushSnapshot(buffer, 0, pose(0));
    pushSnapshot(buffer, 500, pose(5));
    pushSnapshot(buffer, 1500, pose(15));
    expect(buffer.length).toBe(2);
    expect(buffer[0].atMs).toBe(500);
  });
});

describe("samplePose", () => {
  it("returns null when empty or ahead of the buffer", () => {
    expect(samplePose([], 100)).toBeNull();
    const buffer: TimedSnapshot<CarPose>[] = [{ atMs: 100, state: pose(1) }];
    expect(samplePose(buffer, 200)).toBeNull();
  });

  it("clamps to the first sample when predating the buffer", () => {
    const buffer: TimedSnapshot<CarPose>[] = [{ atMs: 100, state: pose(1) }];
    expect(samplePose(buffer, 50)).toEqual(pose(1));
  });

  it("interpolates linearly between bracketing snapshots", () => {
    const buffer: TimedSnapshot<CarPose>[] = [
      { atMs: 0, state: pose(0) },
      { atMs: 100, state: pose(10) },
    ];
    const mid = samplePose(buffer, 50);
    expect(mid?.position[0]).toBeCloseTo(5, 9);
    expect(mid?.linvel[0]).toBeCloseTo(10, 9);
    // Quaternion stays unit length.
    const q = mid!.rotation;
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1, 9);
  });
});

describe("renderTimestamp", () => {
  it("holds back the interp delay", () => {
    expect(renderTimestamp(1000)).toBe(1000 - INTERP_DELAY_MS);
  });
});
