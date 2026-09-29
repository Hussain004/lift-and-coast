import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { PIT_LANE_HALF_WIDTH, getPitLane, laneCovers } from "../lib/tracks/pitLane";
import { checkTrackLimits } from "../lib/tracks/trackLimits";

describe("pit lane", () => {
  it("the big permanent circuits get one, the walled-in street circuits keep the virtual window", () => {
    for (const id of ["silverstone", "monza", "spa", "suzuka", "bahrain", "cota"]) {
      expect(getPitLane(getTrack(id)), id).not.toBeNull();
    }
    expect(getPitLane(getTrack("monaco"))).toBeNull();
  });

  it("is road: a car in the lane is not off track, one on the grass beside it is", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const lane = getPitLane(track);
      if (!lane) continue;
      const mid = Math.floor(lane.points.length / 2);
      const [x, y, z] = lane.points[mid];
      expect(checkTrackLimits(track, x, z, y).isOffTrack, meta.id).toBe(false);
      // Well past the lane's outer edge is grass again.
      const i = lane.indices[mid];
      const c = track.centerline[i];
      const dx = x - c[0];
      const dz = z - c[2];
      const len = Math.hypot(dx, dz);
      const beyond = { x: x + (dx / len) * (PIT_LANE_HALF_WIDTH + 2.5), z: z + (dz / len) * (PIT_LANE_HALF_WIDTH + 2.5) };
      expect(checkTrackLimits(track, beyond.x, beyond.z, y).isOffTrack, meta.id).toBe(true);
    }
  });

  it("peels off and rejoins the track smoothly, and only bulges out on the straight", () => {
    const track = getTrack("silverstone");
    const lane = getPitLane(track)!;
    const gaps = lane.indices.map((i) => lane.gapByIndex[i]);
    expect(gaps[0]).toBeCloseTo(-1, 1);
    expect(gaps[gaps.length - 1]).toBeCloseTo(-1, 1);
    expect(Math.max(...gaps)).toBeCloseTo(8, 1);
    for (let k = 1; k < gaps.length; k++) expect(Math.abs(gaps[k] - gaps[k - 1])).toBeLessThan(0.5);
    // The lane centre never jumps between points.
    for (let k = 1; k < lane.points.length; k++) {
      const [ax, , az] = lane.points[k - 1];
      const [bx, , bz] = lane.points[k];
      expect(Math.hypot(bx - ax, bz - az)).toBeLessThan(6);
    }
  });

  it("puts the box mid-lane, past the start line, inside the lane's band", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const lane = getPitLane(track);
      if (!lane) continue;
      const status = checkTrackLimits(track, lane.box.x, lane.box.z, lane.box.y);
      expect(status.isOffTrack, meta.id).toBe(false);
      expect(laneCovers(lane, lane.box.index, lane.offsetByIndex[lane.box.index])).toBe(true);
    }
  });

  it("only one thing crosses the finish gate, even widened to take in the lane", () => {
    // Car.tsx widens the timing gate so the lane counts; no other stretch of
    // the lap may pass through that wider gate or laps would double count.
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const lane = getPitLane(track);
      if (!lane) continue;
      const { x: sx, z: sz, headingRad } = track.startPos;
      const fx = -Math.sin(headingRad);
      const fz = -Math.cos(headingRad);
      const rx = -fz;
      const rz = fx;
      const reach = track.width[0] / 2 + 8 + PIT_LANE_HALF_WIDTH;
      const n = track.centerline.length;
      let crossings = 0;
      for (let i = 0; i < n; i++) {
        const a = track.centerline[i];
        const b = track.centerline[(i + 1) % n];
        const fa = (a[0] - sx) * fx + (a[2] - sz) * fz;
        const fb = (b[0] - sx) * fx + (b[2] - sz) * fz;
        if (fa < 0 && fb >= 0 && Math.abs((a[0] - sx) * rx + (a[2] - sz) * rz) < reach + 1) crossings++;
      }
      expect(crossings, meta.id).toBe(1);
    }
  });
});

import { createStrategySystem } from "../lib/race/strategy";
import { createHudSnapshot, pitPrompt } from "../lib/race/hud";

describe("pit lane stop rules", () => {
  const base = { dt: 0.1, speedMs: 0, throttle: 0, brake: 1, progressMeters: 100, trackLengthMeters: 5800, lap: 1, racing: true };

  it("on a lane circuit only the box services a stop, not the old straight-line window", () => {
    const strategy = createStrategySystem();
    strategy.requestPit();
    // Parked on the start straight with the virtual window open, but not in the box.
    strategy.update({ ...base, lateralMeters: 6, trackHalfWidthMeters: 6, inPitBox: false });
    expect(strategy.snapshot().pitPhase).toBe("requested");
    strategy.update({ ...base, inPitBox: true });
    expect(strategy.snapshot().pitPhase).toBe("service");
    for (let i = 0; i < 40; i++) strategy.update({ ...base, inPitBox: true });
    expect(strategy.snapshot().pitStops).toBe(1);
  });

  it("circuits without a lane keep the virtual window", () => {
    const strategy = createStrategySystem();
    strategy.requestPit();
    strategy.update({ ...base, progressMeters: 5, lateralMeters: 5, trackHalfWidthMeters: 6 });
    expect(strategy.snapshot().pitPhase).toBe("service");
  });

  it("tells the driver what to do", () => {
    const hud = createHudSnapshot("race", 3);
    expect(pitPrompt(hud)).toBe("");
    hud.pitPhase = "requested";
    hud.hasPitLane = true;
    expect(pitPrompt(hud)).toContain("ENTER THE PIT LANE");
    hud.inPitLane = true;
    hud.pitBoxMeters = 80;
    expect(pitPrompt(hud)).toContain("BOX 80 M");
    hud.pitBoxMeters = -20;
    expect(pitPrompt(hud)).toContain("MISSED");
    hud.pitPhase = "service";
    hud.pitProgress = 0.5;
    expect(pitPrompt(hud)).toBe("PIT STOP · 50%");
  });
});
