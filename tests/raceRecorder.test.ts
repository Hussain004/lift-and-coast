import { describe, expect, it } from "vitest";
import {
  PASS_HOLD_SECONDS,
  createPassTracker,
  createPose,
  createRaceRecorder,
  pickClips,
  updatePassTracker,
} from "../lib/race/raceRecorder";

describe("race recorder", () => {
  it("interpolates a car's pose between 10 Hz samples", () => {
    const rec = createRaceRecorder(2);
    rec.write(1, 0, 0, 0, 0, 0, 0, 1);
    rec.advance(0.1);
    rec.write(1, 10, 2, -4, 0, 0, 0, 1);
    const out = createPose();
    expect(rec.poseAt(1, 0.05, out)).toBe(true);
    expect(out.x).toBeCloseTo(5);
    expect(out.y).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(-2);
    expect(rec.duration()).toBeCloseTo(0.1);
  });

  it("clamps outside the recorded range and refuses an unknown car", () => {
    const rec = createRaceRecorder(1);
    rec.write(0, 3, 0, 0, 0, 0, 0, 1);
    const out = createPose();
    expect(rec.poseAt(0, 99, out)).toBe(true);
    expect(out.x).toBeCloseTo(3);
    expect(rec.poseAt(0, -5, out)).toBe(true);
    expect(rec.poseAt(7, 0, out)).toBe(false);
  });

  it("holds a car's last pose when it stops writing, across chunk boundaries", () => {
    const rec = createRaceRecorder(2);
    rec.write(0, 1, 0, 0, 0, 0, 0, 1);
    rec.write(1, 5, 0, 0, 0, 0, 0, 1);
    rec.advance(130); // two chunks on
    rec.write(0, 2, 0, 0, 0, 0, 0, 1);
    const out = createPose();
    rec.poseAt(1, 130, out);
    expect(out.x).toBeCloseTo(5);
    rec.poseAt(0, 130, out);
    expect(out.x).toBeCloseTo(2);
    rec.poseAt(0, 60, out);
    expect(out.x).toBeCloseTo(1);
  });

  it("never moves the cursor backwards", () => {
    const rec = createRaceRecorder(1);
    rec.advance(5);
    rec.advance(2);
    expect(rec.duration()).toBeCloseTo(5);
  });

  it("takes the short way round between quaternions of opposite sign", () => {
    const rec = createRaceRecorder(1);
    rec.write(0, 0, 0, 0, 0, 0, 0, 1);
    rec.advance(0.1);
    rec.write(0, 0, 0, 0, 0, 0, 0, -1); // same rotation, other sign
    const out = createPose();
    rec.poseAt(0, 0.05, out);
    expect(Math.abs(out.qw)).toBeCloseTo(1);
  });
});

describe("pass tracker", () => {
  it("reports a gained place only after it has held", () => {
    const t = createPassTracker();
    expect(updatePassTracker(t, 5, 20)).toBeNull();
    expect(updatePassTracker(t, 4, 30)).toBeNull();
    expect(updatePassTracker(t, 4, 30 + PASS_HOLD_SECONDS - 0.1)).toBeNull();
    const e = updatePassTracker(t, 4, 30 + PASS_HOLD_SECONDS);
    expect(e?.kind).toBe("pass");
    expect(e?.t).toBe(30);
  });

  it("ignores a place that is lost again, and the opening scramble", () => {
    const t = createPassTracker();
    updatePassTracker(t, 8, 1);
    expect(updatePassTracker(t, 3, 2)).toBeNull();
    expect(updatePassTracker(t, 3, 40)).toBeNull(); // baseline was still being reset before 8 s
    updatePassTracker(t, 5, 50);
    updatePassTracker(t, 4, 52);
    expect(updatePassTracker(t, 5, 53)).toBeNull();
    expect(updatePassTracker(t, 5, 60)).toBeNull();
  });

  it("calls out a multi-place gain differently", () => {
    const t = createPassTracker();
    updatePassTracker(t, 8, 20);
    updatePassTracker(t, 6, 25);
    expect(updatePassTracker(t, 6, 28)?.label).toBe("UP TO P6");
  });
});

describe("clips", () => {
  it("merges overlapping moments and keeps the start first", () => {
    const clips = pickClips(
      [
        { t: 0, kind: "start", car: 0, label: "LIGHTS OUT" },
        { t: 40, kind: "pass", car: 0, label: "OVERTAKE · P3" },
        { t: 42, kind: "contact", car: 0, label: "CONTACT" },
        { t: 200, kind: "finish", car: 0, label: "CHEQUERED FLAG" },
      ],
      205
    );
    expect(clips).toHaveLength(3);
    expect(clips[0]).toMatchObject({ from: 0, label: "LIGHTS OUT" });
    expect(clips[1]).toMatchObject({ from: 37, to: 46, label: "OVERTAKE · P3" });
    expect(clips[2].to).toBe(204);
  });
});
