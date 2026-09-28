import { describe, expect, it } from "vitest";
import { createReplayController, type ReplayFrame } from "../lib/race/replay";
import { createPoseRing } from "../lib/race/poseRing";

const DT = 1 / 60;

function frame(x: number, elapsedSeconds: number): ReplayFrame {
  return {
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linvel: { x: 0, y: 0, z: 0 },
    angvel: { x: 0, y: 0, z: 0 },
    telemetry: {
      elapsedSeconds,
      speedMs: 0,
      throttle: 0,
      brake: 0,
      steer: 0,
      gear: 1,
      rpm: 0,
      batteryFraction: 1,
      tireGrip: 1,
      overtakeActive: false,
      weather: "clear",
    },
  };
}

describe("replay timeline", () => {
  it("is step-indexed, so a frozen race clock or a penalty jump cannot distort it", () => {
    const replay = createReplayController(10, DT);
    // 60 frames before lights out (clock frozen at 0), then 60 frames where a
    // +5s penalty lands halfway through.
    for (let i = 0; i < 120; i++) {
      const clock = i < 60 ? 0 : (i - 60) * DT + (i >= 90 ? 5 : 0);
      replay.record(frame(i, clock));
    }
    expect(replay.state().durationSeconds).toBeCloseTo(119 * DT, 9);
    replay.togglePlayback();
    replay.seekRelative(30 * DT);
    expect(replay.frameAtCursor()!.position.x).toBeCloseTo(30, 5);
    expect(replay.secondsBehindLive()).toBeCloseTo(89 * DT, 9);
  });

  it("hands back the live frame to restore when playback ends early", () => {
    const replay = createReplayController(10, DT);
    for (let i = 0; i < 100; i++) replay.record(frame(i, i * DT));
    replay.togglePlayback();
    replay.seekRelative(0.5);
    replay.togglePlayback(); // stopped midway
    expect(replay.secondsBehindLive()).toBe(0);
    expect(replay.liveFrame()!.position.x).toBe(99);
  });
});

describe("pose ring", () => {
  it("lines up with the player's replay by steps behind live", () => {
    const replay = createReplayController(10, DT);
    const ring = createPoseRing(10, DT);
    for (let i = 0; i < 200; i++) {
      replay.record(frame(i, i * DT));
      ring.push(frame(i * 2, 0));
    }
    replay.togglePlayback();
    replay.seekRelative(1);
    const playerX = replay.frameAtCursor()!.position.x;
    const aiX = ring.sampleAt(replay.secondsBehindLive())!.position.x;
    expect(aiX).toBeCloseTo(playerX * 2, 3);
    expect(ring.sampleAt(0)!.position.x).toBe(398);
  });

  it("wraps and clamps to the oldest pose it still holds", () => {
    const ring = createPoseRing(1, DT); // 60 slots
    for (let i = 0; i < 150; i++) ring.push(frame(i, 0));
    expect(ring.sampleAt(0)!.position.x).toBe(149);
    expect(ring.sampleAt(59 * DT)!.position.x).toBe(90);
    expect(ring.sampleAt(99)!.position.x).toBe(90);
  });
});
