import { describe, expect, it } from "vitest";
import {
  closeReplay,
  createRaceReplay,
  openReplay,
  pickReplayStand,
  setHighlights,
  stepClip,
  stepRaceReplay,
} from "../lib/race/raceReplay";

function replayWithMoments() {
  const r = createRaceReplay(3);
  r.recorder.advance(100);
  r.recorder.addEvent({ t: 0, kind: "start", car: 0, label: "LIGHTS OUT" });
  r.recorder.addEvent({ t: 40, kind: "pass", car: 0, label: "OVERTAKE · P2" });
  r.recorder.addEvent({ t: 80, kind: "fastest", car: 2, label: "FASTEST LAP · CCC" });
  return r;
}

describe("race replay playhead", () => {
  it("plays at speed and stops at the end", () => {
    const r = createRaceReplay(1);
    r.recorder.advance(10);
    openReplay(r);
    r.speed = 2;
    stepRaceReplay(r, 3);
    expect(r.t).toBeCloseTo(6);
    stepRaceReplay(r, 10);
    expect(r.t).toBeCloseTo(10);
    expect(r.playing).toBe(false);
  });

  it("does nothing while paused or closed", () => {
    const r = createRaceReplay(1);
    r.recorder.advance(10);
    stepRaceReplay(r, 1);
    expect(r.t).toBe(0);
    openReplay(r);
    r.playing = false;
    stepRaceReplay(r, 1);
    expect(r.t).toBe(0);
    closeReplay(r);
    expect(r.active).toBe(false);
  });

  it("hops through the highlights and follows each clip's car", () => {
    const r = replayWithMoments();
    openReplay(r);
    setHighlights(r, true);
    expect(r.clips).toHaveLength(3);
    expect(r.t).toBe(0);
    stepRaceReplay(r, 9.5); // past the 9 s start clip
    expect(r.clipIndex).toBe(1);
    expect(r.t).toBeCloseTo(37);
    r.t = 80;
    stepClip(r, 1);
    expect(r.clipIndex).toBe(2);
    expect(r.follow).toBe(2);
    stepRaceReplay(r, 100);
    expect(r.playing).toBe(false);
  });

  it("steps clips back and forth from the full race", () => {
    const r = replayWithMoments();
    openReplay(r);
    r.t = 50;
    stepClip(r, -1);
    expect(r.t).toBeCloseTo(37);
    stepClip(r, -1);
    expect(r.t).toBe(0);
    stepClip(r, -1);
    expect(r.t).toBe(0);
  });

  it("with no recorded moments highlights stay off", () => {
    const r = createRaceReplay(1);
    r.recorder.advance(10);
    openReplay(r);
    setHighlights(r, true);
    expect(r.clips).toBeNull();
  });
});

describe("replay stand choice", () => {
  const stands = [
    { x: 0, z: 0 }, // at the car
    { x: 0, z: -60 }, // ahead, 60 m
    { x: 0, z: 60 }, // behind
    { x: 200, z: -10 }, // too far
  ];
  it("prefers a stand ahead at a comfortable distance", () => {
    expect(pickReplayStand(stands, 0, 0, 0, -1)).toBe(1);
  });
  it("falls back to the nearest stand when none is ahead", () => {
    expect(pickReplayStand(stands, 0, 0, 1, 0)).toBe(0);
  });
});

import { cycleSpeed, seekReplay, toggleView } from "../lib/race/raceReplay";

describe("replay controls", () => {
  it("cycles speed and view, and seeking clamps and drops highlights", () => {
    const r = replayWithMoments();
    openReplay(r);
    cycleSpeed(r);
    expect(r.speed).toBe(2);
    cycleSpeed(r);
    cycleSpeed(r);
    expect(r.speed).toBe(0.5);
    toggleView(r);
    expect(r.view).toBe("chase");
    setHighlights(r, true);
    seekReplay(r, 9999);
    expect(r.t).toBeCloseTo(100);
    expect(r.clips).toBeNull();
  });
});
