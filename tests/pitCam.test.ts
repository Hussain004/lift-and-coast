import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { PIT_BOX_HALF_LENGTH, PIT_LANE_HALF_WIDTH, getPitLane } from "../lib/tracks/pitLane";
import {
  PIT_CAM_SPEED_MS,
  createPitCamState,
  pitCamPose,
  pitCamSettled,
  stepPitCam,
  type PitCamPose,
} from "../lib/race/pitCam";

describe("pitCamPose", () => {
  it("frames the box from ahead on the track side, and looks at the box", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const pose = pitCamPose(track);
      if (!pose) {
        // No pose on a circuit with no pit lane, and only there.
        expect(getPitLane(track), meta.id).toBeNull();
        continue;
      }
      const lane = getPitLane(track)!;
      for (const v of [pose.ex, pose.ey, pose.ez, pose.ax, pose.ay, pose.az]) {
        expect(Number.isFinite(v), meta.id).toBe(true);
      }
      // The aim is the box, lifted a little: that is what centres the car.
      expect(pose.ax, meta.id).toBeCloseTo(lane.box.x, 9);
      expect(pose.az, meta.id).toBeCloseTo(lane.box.z, 9);
      expect(pose.ay, meta.id).toBeGreaterThan(lane.box.y);

      // Eye is up the lane from the box (the camera looks back down the row
      // of boxes, the broadcast garage framing), not beside or behind it.
      const h = lane.box.headingRad;
      const ahead =
        (pose.ex - lane.box.x) * -Math.sin(h) + (pose.ez - lane.box.z) * -Math.cos(h);
      expect(ahead, meta.id).toBeGreaterThan(3);
      // ...and on the TRACK side of the lane, opposite the garages, so the
      // lollipop man (who stands ahead on the garage side) is beyond the car
      // rather than between the eye and the car.
      const right =
        (pose.ex - lane.box.x) * Math.cos(h) + (pose.ez - lane.box.z) * -Math.sin(h);
      expect(Math.sign(right), meta.id).toBe(-lane.sign);
      // Above the roofline of nothing in particular: high enough to look over
      // the car, low enough to stay out of the garages.
      expect(pose.ey, meta.id).toBeGreaterThan(lane.box.y + 1.5);
    }
  });

  it("keeps the eye on the track side, so nothing is between it and the car", () => {
    // The lollipop man is 4.3 m up the lane from the box on the garage side,
    // his disc at 2.2 m up. A camera ahead on THAT side looks straight
    // through him and the car disappears - the second version of this
    // camera's bug, also found by screenshotting it. From the track side the
    // sight line to the box is clear and the light is still visible.
    for (const id of ["monza", "silverstone", "spa", "suzuka"]) {
      const track = getTrack(id);
      const lane = getPitLane(track)!;
      const pose = pitCamPose(track)!;
      const h = lane.box.headingRad;
      // Both the eye and the lollipop, in the same lane-centred frame.
      const eyeSide =
        (pose.ex - lane.box.x) * Math.cos(h) + (pose.ez - lane.box.z) * -Math.sin(h);
      const eyeAhead =
        (pose.ex - lane.box.x) * -Math.sin(h) + (pose.ez - lane.box.z) * -Math.cos(h);
      // Lollipop local position from PitCrew.tsx: lane.sign * 1.6 across,
      // 4.3 m ahead (its -4.3 z is up the lane in the crew's frame).
      const lolliSide = lane.sign * 1.6;
      const lolliAhead = 4.3;
      // Eye is ahead of the lollipop, and on the opposite side of the lane:
      // so the segment eye -> box never passes through the lollipop.
      expect(eyeAhead, id).toBeGreaterThan(lolliAhead);
      expect(Math.sign(eyeSide), id).toBe(-Math.sign(lolliSide));
      // The lollipop is across the lane from the eye, and the car is on the
      // line between them: no part of the eye -> car segment is on the
      // lollipop's side, so nothing stands in front of the car.
      expect(eyeSide * lolliSide, id).toBeLessThan(0);
    }
  });

  it("keeps the eye inside the lane, clear of the garage walls", () => {
    // This is the bug the first version of this camera had: it sat 5.5 m
    // off the lane centre, which is PAST the garage front face (half width +
    // 0.7), so the eye was inside a solid 4.2 m building and the whole shot
    // was a flat grey wall. The eye must stay on the asphalt.
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      if (!getPitLane(track)) continue;
      const lane = getPitLane(track)!;
      const pose = pitCamPose(track)!;
      const h = lane.box.headingRad;
      const lateral =
        (pose.ex - lane.box.x) * Math.cos(h) + (pose.ez - lane.box.z) * -Math.sin(h);
      expect(Math.abs(lateral), meta.id).toBeLessThan(PIT_LANE_HALF_WIDTH);
      // Clear of the garage face with room to spare, not merely inside.
      expect(Math.abs(lateral), meta.id).toBeLessThanOrEqual(PIT_LANE_HALF_WIDTH - 0.8);
      // Below the garage roof as well, so no circuit can clip it.
      expect(pose.ey, meta.id).toBeLessThan(lane.box.y + 4.2);
    }
  });

  it("looks at a point the car actually occupies, from far enough back to frame it", () => {
    // The aim must be inside the box the car has to stop in, or the camera
    // frames empty asphalt beside the car.
    for (const id of ["monza", "silverstone", "spa"]) {
      const track = getTrack(id);
      const lane = getPitLane(track)!;
      const pose = pitCamPose(track)!;
      expect(
        Math.hypot(pose.ax - lane.box.x, pose.az - lane.box.z),
        id
      ).toBeLessThan(PIT_BOX_HALF_LENGTH);
      expect(Math.hypot(pose.ex - lane.box.x, pose.ez - lane.box.z), id).toBeGreaterThan(6);
      // And the eye is up the lane, not on the racing line.
      expect(Math.hypot(pose.ex - lane.box.x, pose.ez - lane.box.z), id).toBeLessThan(14);
    }
  });
});

describe("stepPitCam", () => {
  const target: PitCamPose = { ex: 10, ey: 4, ez: -20, ax: 0, ay: 1, az: 0 };
  const DT = 1 / 60;
  /** Largest remaining component, i.e. how far the pose still has to travel. */
  const remaining = (state: ReturnType<typeof createPitCamState>, t: PitCamPose) =>
    Math.max(
      Math.abs(t.ex - state.ex),
      Math.abs(t.ey - state.ey),
      Math.abs(t.ez - state.ez),
      Math.abs(t.ax - state.ax),
      Math.abs(t.ay - state.ay),
      Math.abs(t.az - state.az)
    );

  it("snaps on the first tick, so entering the box is instant", () => {
    const state = createPitCamState();
    expect(state.started).toBe(false);
    stepPitCam(state, target, DT);
    expect(state.started).toBe(true);
    expect(state.ex).toBe(10);
    expect(state.ay).toBe(1);
    expect(pitCamSettled(state, target)).toBe(true);
  });

  it("travels at a fixed closing speed, whatever the distance", () => {
    const near = createPitCamState();
    near.started = true;
    stepPitCam(near, target, DT);
    expect(remaining(near, target)).toBeCloseTo(20 - PIT_CAM_SPEED_MS * DT, 9);

    // The step is the same metres for a pose that starts far away, which is
    // what a constant closing speed means - no exponential settling tail.
    const far: PitCamPose = { ex: 900, ey: 400, ez: -2000, ax: 0, ay: 1, az: 0 };
    const distant = createPitCamState();
    distant.started = true;
    stepPitCam(distant, far, DT);
    expect(remaining(distant, far)).toBeCloseTo(2000 - PIT_CAM_SPEED_MS * DT, 6);
  });

  it("keeps the pose's shape on the way in rather than shearing it", () => {
    const state = createPitCamState();
    state.started = true;
    stepPitCam(state, target, DT);
    // Every component moved by the same fraction of the step.
    const fraction = 1 - (20 - PIT_CAM_SPEED_MS * DT) / 20;
    expect(state.ex / 10).toBeCloseTo(fraction, 9);
    expect(state.ey / 4).toBeCloseTo(fraction, 9);
    expect(state.ez / -20).toBeCloseTo(fraction, 9);
  });

  it("arrives exactly, quickly, and without a settling wobble", () => {
    const state = createPitCamState();
    stepPitCam(state, target, DT);
    let ticks = 0;
    while (!pitCamSettled(state, target) && ticks < 10_000) {
      stepPitCam(state, target, DT);
      ticks++;
    }
    expect(pitCamSettled(state, target)).toBe(true);
    // 20 m at 26 m/s is under a second of frames.
    expect(ticks).toBeLessThan(60);
    expect(state.ex).toBe(target.ex);
    expect(state.ez).toBe(target.ez);
  });

  it("a huge dt arrives without jumping past the target", () => {
    const state = createPitCamState();
    state.started = true;
    stepPitCam(state, target, 1000);
    expect(pitCamSettled(state, target)).toBe(true);
  });

  it("a negative or zero dt cannot move the pose at all", () => {
    const state = createPitCamState();
    state.started = true;
    state.ex = 3;
    stepPitCam(state, target, 0);
    expect(state.ex).toBe(3);
    stepPitCam(state, target, -1);
    expect(state.ex).toBe(3);
  });

  it("every component - eye and aim alike - moves by the same fraction of its own gap", () => {
    // The invariant that matters is that all six components share ONE scale
    // factor. Equal absolute distances would be the wrong assertion: the
    // components have different magnitudes, so what has to match is the
    // fraction of each one's remaining gap that gets closed per tick. If
    // eye and aim ever ran on separate filters (or separate speeds) the
    // fractions would diverge and the camera would look somewhere it is not.
    const state = createPitCamState();
    state.started = true;
    const gaps = [target.ex, target.ey, target.ez, target.ax, target.ay, target.az];
    // 20 m at 26 m/s is ~47 ticks, so the loop is bounded well past that.
    for (let i = 0; i < 200 && !pitCamSettled(state, target); i++) {
      const before = [state.ex, state.ey, state.ez, state.ax, state.ay, state.az];
      stepPitCam(state, target, DT);
      const fractions: number[] = [];
      for (let k = 0; k < 6; k++) {
        const gapBefore = gaps[k] - before[k];
        const moved = Math.abs(gaps[k] - [state.ex, state.ey, state.ez, state.ax, state.ay, state.az][k]);
        if (gapBefore !== 0) fractions.push(moved / Math.abs(gapBefore));
      }
      if (fractions.length > 0) {
        for (const fraction of fractions) {
          expect(fraction).toBeCloseTo(fractions[0], 9);
        }
        // And that fraction is always at most 1 - the pose never overshoots
        // on any axis, including the aim. (On the final tick it is 0, which
        // is the clamp landing exactly on the target.)
        expect(fractions[0]).toBeLessThanOrEqual(1);
      }
    }
    expect(pitCamSettled(state, target)).toBe(true);
  });
});
