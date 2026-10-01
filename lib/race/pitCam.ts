// Pure: geometry in, filtered pose out. No three.js here.
import type { PitReleasePhase } from "./pitRelease";
import type { PitPhase } from "./strategy";
import { PIT_LANE_HALF_WIDTH, getPitLane, type PitLane } from "../tracks/pitLane";
import type { TrackData } from "../tracks/types";

/**
 * Whether the pit camera should own the view. It holds through the service
 * and the green window, then hands the camera straight back - so the driver
 * sees the crew working, the light, and their own release, and is looking
 * down the pit exit the moment they are released.
 *
 * Deliberately NOT held through "resolved"/"missed": by then the car is
 * driving again and a garage camera would be a view of a wall it has left.
 */
export function pitCamActive(input: {
  pitPhase: PitPhase;
  releasePhase: PitReleasePhase;
}): boolean {
  return input.pitPhase === "service" || input.releasePhase === "green";
}

/**
 * How far up the lane from the box the eye sits, metres. Ahead of the car
 * rather than beside or behind it, so the shot looks back down the row of
 * boxes with the crew working in the near half of frame.
 */
const AHEAD_METERS = 8;

/**
 * How far off the lane centre the eye sits, metres, and WHICH side.
 *
 * The side is the TRACK side - the opposite of lane.sign - and that is
 * load-bearing rather than incidental:
 *
 *  - The garages are solid: their front face stands PIT_LANE_HALF_WIDTH + 0.7
 *    off the centre and they are 4.2 m tall (lib/tracks/pitLaneMesh.ts). An
 *    eye further out than the painted edge is therefore INSIDE a building and
 *    the shot is a flat grey wall - which is exactly what the first version
 *    of this camera did, found by screenshotting it.
 *  - The lollipop man stands AHEAD of the box on the garage side
 *    (PitCrew.tsx, at lane.sign * 1.6 and 4.3 m up the lane), so a camera
 *    ahead on that same side looks straight THROUGH him: his 0.84 m disc at
 *    2.2 m up sat dead centre of frame and hid the car. From the track side
 *    he is beyond the car instead, which frames the shot properly and keeps
 *    the green light - the thing the player has to read - fully visible.
 *
 * Either way the eye stays on the asphalt, so nothing can occlude it.
 */
const SIDE_METERS = 2.2;

/** Eye height above the road, metres - a camera on the pit wall. */
const HEIGHT_METERS = 2.7;

/** Aim point: the box itself, lifted a little to centre the car in frame. */
const AIM_HEIGHT_METERS = 1.1;

/**
 * Closing speed of the move into and out of the pit camera, m/s. Fast
 * enough that the cut reads as a deliberate camera move rather than a
 * lurch (the whole move takes well under a second at this speed), slow
 * enough that the destination is never overshot: the step is clamped to
 * the remaining distance, so arrival is exact and there is no settling
 * wobble on arrival or on the way back.
 */
export const PIT_CAM_SPEED_MS = 26;

export interface PitCamPose {
  ex: number;
  ey: number;
  ez: number;
  ax: number;
  ay: number;
  az: number;
}

/** The running pose, so the filter can carry it across frames. */
export interface PitCamState extends PitCamPose {
  /** False until the first step, which snaps instead of travelling. */
  started: boolean;
}

export function createPitCamState(): PitCamState {
  return { ex: 0, ey: 0, ez: 0, ax: 0, ay: 0, az: 0, started: false };
}

/**
 * The fixed garage-side pose for this circuit's box, or null when the
 * circuit has no pit lane (and so no box to look at).
 */
export function pitCamPose(track: TrackData, lane?: PitLane | null): PitCamPose | null {
  const pitLane = lane === undefined ? getPitLane(track) : lane;
  if (!pitLane) return null;
  const { x, y, z, headingRad } = pitLane.box;
  // The box's own heading: forward is (-sin yaw, -cos yaw) and right is
  // (cos yaw, -sin yaw), the same convention as the minimap
  // (lib/tracks/minimap.ts) and the pit crew's local axes.
  const fx = -Math.sin(headingRad);
  const fz = -Math.cos(headingRad);
  const rx = Math.cos(headingRad);
  const rz = -Math.sin(headingRad);
  // Never past the painted edge of the lane, which is where the garage
  // buildings start (see SIDE_METERS). Clamped rather than assumed so a
  // future edit to SIDE_METERS cannot quietly put the camera inside a wall
  // again - which is the bug this clamp exists to make impossible.
  const side = Math.min(SIDE_METERS, PIT_LANE_HALF_WIDTH - 0.8) * -pitLane.sign;
  return {
    ex: x + fx * AHEAD_METERS + rx * side * pitLane.sign,
    ey: y + HEIGHT_METERS,
    ez: z + fz * AHEAD_METERS + rz * side * pitLane.sign,
    ax: x,
    ay: y + AIM_HEIGHT_METERS,
    az: z,
  };
}

/**
 * Moves `state` one tick toward `target` at a fixed closing speed, shared
 * across all six components so the eye and the aim are always on the same
 * filter. Snaps on the first tick (there is nothing to travel from that
 * matters - the incoming view is wherever the other camera left it) and
 * thereafter travels at most PIT_CAM_SPEED_MS * dt, clamped to the
 * remaining distance so it arrives exactly and never overshoots.
 *
 * Returns the same object it was given, so a caller can hold the instance
 * in a ref and read it straight into the three.js camera.
 */
export function stepPitCam(state: PitCamState, target: PitCamPose, dt: number): PitCamState {
  if (!state.started) {
    state.ex = target.ex;
    state.ey = target.ey;
    state.ez = target.ez;
    state.ax = target.ax;
    state.ay = target.ay;
    state.az = target.az;
    state.started = true;
    return state;
  }
  const maxStep = PIT_CAM_SPEED_MS * Math.max(0, dt);
  const dx = target.ex - state.ex;
  const dy = target.ey - state.ey;
  const dz = target.ez - state.ez;
  const dax = target.ax - state.ax;
  const day = target.ay - state.ay;
  const daz = target.az - state.az;
  // Longest remaining component sets the scale, so every axis uses the same
  // fraction of the step and the pose keeps its shape while it travels.
  const remaining = Math.max(
    Math.abs(dx),
    Math.abs(dy),
    Math.abs(dz),
    Math.abs(dax),
    Math.abs(day),
    Math.abs(daz)
  );
  if (remaining <= maxStep || remaining === 0) {
    state.ex = target.ex;
    state.ey = target.ey;
    state.ez = target.ez;
    state.ax = target.ax;
    state.ay = target.ay;
    state.az = target.az;
    return state;
  }
  const scale = maxStep / remaining;
  state.ex += dx * scale;
  state.ey += dy * scale;
  state.ez += dz * scale;
  state.ax += dax * scale;
  state.ay += day * scale;
  state.az += daz * scale;
  return state;
}

/**
 * True once the pose has fully arrived, so the caller can skip the rest of
 * the camera code on frames where nothing is moving.
 */
export function pitCamSettled(state: PitCamState, target: PitCamPose): boolean {
  return (
    state.ex === target.ex &&
    state.ey === target.ey &&
    state.ez === target.ez &&
    state.ax === target.ax &&
    state.ay === target.ay &&
    state.az === target.az
  );
}