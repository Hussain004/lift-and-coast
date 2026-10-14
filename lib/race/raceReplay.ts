// Post-race replay state: a playhead over the whole-race recording
// (raceRecorder.ts), with play/pause, speed, a highlights mode that hops from
// clip to clip, and a followed car. Pure; the physics step advances it and the
// camera and UI read it.

import { createRaceRecorder, pickClips, type Clip, type Pose, type RaceRecorder } from "./raceRecorder";

export type ReplayView = "tv" | "chase";

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;

export interface RaceReplay {
  recorder: RaceRecorder;
  /** True while the field is posed from the recording instead of simulated. */
  active: boolean;
  t: number;
  playing: boolean;
  speed: number;
  /** Car index being followed (0 = the player). */
  follow: number;
  view: ReplayView;
  /** Highlights mode: the clips being played in order, or null for the full race. */
  clips: Clip[] | null;
  clipIndex: number;
}

export function createRaceReplay(cars: number): RaceReplay {
  return {
    recorder: createRaceRecorder(cars),
    active: false,
    t: 0,
    playing: true,
    speed: 1,
    follow: 0,
    view: "tv",
    clips: null,
    clipIndex: 0,
  };
}

/** Starts a full-race replay from the beginning. */
export function openReplay(replay: RaceReplay): void {
  replay.active = true;
  replay.t = 0;
  replay.playing = true;
  replay.speed = 1;
  replay.clips = null;
}

export function closeReplay(replay: RaceReplay): void {
  replay.active = false;
  replay.clips = null;
}

/** The notable moments as clips, in time order. */
export function replayClips(replay: RaceReplay): Clip[] {
  return pickClips(replay.recorder.events, replay.recorder.duration());
}

/** Switches to the highlights reel (or back to the full race). */
export function setHighlights(replay: RaceReplay, on: boolean): void {
  if (!on) {
    replay.clips = null;
    return;
  }
  const clips = replayClips(replay);
  if (clips.length === 0) {
    replay.clips = null;
    return;
  }
  replay.clips = clips;
  replay.clipIndex = 0;
  replay.t = clips[0].from;
  replay.follow = clips[0].car;
  replay.playing = true;
}

/** Jumps to the next/previous clip, entering highlights mode if needed. */
export function stepClip(replay: RaceReplay, delta: 1 | -1): void {
  if (!replay.clips) {
    const clips = replayClips(replay);
    if (clips.length === 0) return;
    replay.clips = clips;
    const here = clips.findIndex((c) => c.to > replay.t);
    replay.clipIndex = here < 0 ? clips.length - 1 : here;
    if (delta > 0 && here >= 0 && clips[here].from > replay.t) replay.clipIndex = here - 1;
  }
  const clips = replay.clips as Clip[];
  replay.clipIndex = Math.min(clips.length - 1, Math.max(0, replay.clipIndex + delta));
  replay.t = clips[replay.clipIndex].from;
  replay.follow = clips[replay.clipIndex].car;
  replay.playing = true;
}

/** Advances the playhead by `dt` real seconds. */
export function stepRaceReplay(replay: RaceReplay, dt: number): void {
  if (!replay.active || !replay.playing) return;
  const end = replay.recorder.duration();
  replay.t += dt * replay.speed;
  const clips = replay.clips;
  if (clips) {
    const clip = clips[replay.clipIndex];
    if (replay.t >= clip.to) {
      if (replay.clipIndex + 1 < clips.length) {
        replay.clipIndex += 1;
        replay.t = clips[replay.clipIndex].from;
        replay.follow = clips[replay.clipIndex].car;
      } else {
        replay.t = clip.to;
        replay.playing = false;
      }
    }
    return;
  }
  if (replay.t >= end) {
    replay.t = end;
    replay.playing = false;
  }
}

export interface CamStand {
  x: number;
  z: number;
}

/**
 * Which trackside stand to watch a car from: one ahead of it (so the car
 * drives towards the lens), 30-110 m away, nearest to a comfortable 55 m.
 * Falls back to the nearest stand of all when none is ahead. `heading` is the
 * car's forward direction as a unit (x, z) vector.
 */
export function pickReplayStand(
  stands: readonly CamStand[],
  x: number,
  z: number,
  headingX: number,
  headingZ: number
): number {
  let best = -1;
  let bestScore = Infinity;
  let nearest = 0;
  let nearestDist = Infinity;
  stands.forEach((s, i) => {
    const dx = s.x - x;
    const dz = s.z - z;
    const dist = Math.hypot(dx, dz);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = i;
    }
    const ahead = dx * headingX + dz * headingZ > 0;
    if (!ahead || dist < 30 || dist > 110) return;
    const score = Math.abs(dist - 55);
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best >= 0 ? best : nearest;
}

interface PoseTarget {
  setTranslation(v: { x: number; y: number; z: number }, wake: boolean): void;
  setRotation(q: { x: number; y: number; z: number; w: number }, wake: boolean): void;
  setLinvel(v: { x: number; y: number; z: number }, wake: boolean): void;
  setAngvel(v: { x: number; y: number; z: number }, wake: boolean): void;
}

const ZERO = { x: 0, y: 0, z: 0 };
const scratchPos = { x: 0, y: 0, z: 0 };
const scratchRot = { x: 0, y: 0, z: 0, w: 1 };

/** Puts a physics body exactly on a recorded pose and holds it there. */
export function applyReplayPose(body: PoseTarget, pose: Pose): void {
  scratchPos.x = pose.x;
  scratchPos.y = pose.y;
  scratchPos.z = pose.z;
  scratchRot.x = pose.qx;
  scratchRot.y = pose.qy;
  scratchRot.z = pose.qz;
  scratchRot.w = pose.qw;
  body.setTranslation(scratchPos, true);
  body.setRotation(scratchRot, true);
  body.setLinvel(ZERO, true);
  body.setAngvel(ZERO, true);
}

/** Jumps the playhead (leaves highlights mode, since the player took over). */
export function seekReplay(replay: RaceReplay, t: number): void {
  replay.clips = null;
  replay.t = Math.max(0, Math.min(replay.recorder.duration(), t));
}

export function togglePlay(replay: RaceReplay): void {
  replay.playing = !replay.playing;
}

/** 0.5x -> 1x -> 2x -> 4x -> back to 0.5x. */
export function cycleSpeed(replay: RaceReplay): void {
  const i = REPLAY_SPEEDS.findIndex((s) => s === replay.speed);
  replay.speed = REPLAY_SPEEDS[(i + 1) % REPLAY_SPEEDS.length];
}

export function toggleView(replay: RaceReplay): void {
  replay.view = replay.view === "tv" ? "chase" : "tv";
}

export function followCar(replay: RaceReplay, car: number): void {
  replay.follow = car;
}
