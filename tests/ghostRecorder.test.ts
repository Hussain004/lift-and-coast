import { describe, expect, it } from "vitest";
import { MAX_RECORDING_SAMPLES, createGhostRecorder, type GhostPose } from "../lib/race/ghostRecorder";

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function pose(x: number): GhostPose {
  return { position: { x, y: 0, z: 0 }, rotation: IDENTITY };
}

describe("createGhostRecorder", () => {
  it("has no pose until a reference lap exists", () => {
    const ghost = createGhostRecorder();
    ghost.recordSample(0, pose(0));
    ghost.recordSample(1, pose(10));
    expect(ghost.poseAt(0.5)).toBeNull();
  });

  it("interpolates position between recorded samples once a reference lap is set", () => {
    const ghost = createGhostRecorder();
    ghost.recordSample(0, pose(0));
    ghost.recordSample(1, pose(10));
    ghost.endLap(true);

    const midpoint = ghost.poseAt(0.5);
    expect(midpoint?.position.x).toBeCloseTo(5, 5);
  });

  it("clamps to the first/last sample outside the recorded range", () => {
    const ghost = createGhostRecorder();
    ghost.recordSample(1, pose(10));
    ghost.recordSample(2, pose(20));
    ghost.endLap(true);

    expect(ghost.poseAt(0)?.position.x).toBeCloseTo(10, 5);
    expect(ghost.poseAt(5)?.position.x).toBeCloseTo(20, 5);
  });

  it("discards an ineligible lap without replacing the existing reference", () => {
    const ghost = createGhostRecorder();
    ghost.recordSample(0, pose(0));
    ghost.recordSample(1, pose(10));
    ghost.endLap(true);

    ghost.recordSample(0, pose(999));
    ghost.endLap(false);

    expect(ghost.poseAt(1)?.position.x).toBeCloseTo(10, 5);
  });

  it("takes the short way around when blending quaternions on opposite hemispheres", () => {
    const ghost = createGhostRecorder();
    const negated = { x: -0, y: -0, z: -0, w: -1 };
    ghost.recordSample(0, { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY });
    ghost.recordSample(1, { position: { x: 0, y: 0, z: 0 }, rotation: negated });
    ghost.endLap(true);

    const mid = ghost.poseAt(0.5);
    // IDENTITY and its negation represent the same rotation, so blending
    // toward "the short way" should stay at (approximately) IDENTITY, not
    // pass through a very different orientation partway.
    expect(mid?.rotation.w).toBeGreaterThan(0.9);
  });

  it("never adopts an overlong lap as the reference, even when marked eligible", () => {
    const ghost = createGhostRecorder();
    for (let i = 0; i < MAX_RECORDING_SAMPLES + 10; i++) {
      ghost.recordSample(i, pose(i));
    }
    ghost.endLap(true);

    expect(ghost.poseAt(0)).toBeNull();
  });
});
