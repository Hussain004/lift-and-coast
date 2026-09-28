import type { RewindSample } from "./rewindBuffer";

export interface TelemetryFrame {
  elapsedSeconds: number;
  speedMs: number;
  throttle: number;
  brake: number;
  steer: number;
  gear: number;
  rpm: number;
  batteryFraction: number;
  tireGrip: number;
  overtakeActive: boolean;
  weather: string;
}

export interface ReplayFrame extends RewindSample {
  telemetry: TelemetryFrame;
}

export interface ReplayState {
  recording: boolean;
  playback: boolean;
  cursorSeconds: number;
  durationSeconds: number;
  frameCount: number;
}

/** The field-wide replay clock: the player's replay drives it, every AI car
 * follows it (see Car.tsx / AICar.tsx). */
export interface SharedReplay {
  active: boolean;
  /** How far behind live the replay cursor sits. */
  secondsBack: number;
}

/**
 * A compact rolling replay/telemetry recorder. It deliberately stores the
 * same physics snapshot as rewind plus a small telemetry row, so instant
 * replay and the data trace cannot disagree about what the car was doing.
 */
/** Instant-replay length, shared by the player's recorder and the AI's pose
 * rings so every car holds the same window. */
export const REPLAY_CAPACITY_SECONDS = 45;

export function createReplayController(
  capacitySeconds = REPLAY_CAPACITY_SECONDS,
  timestep = 1 / 60
) {
  const capacity = Math.max(2, Math.round(capacitySeconds / Math.max(1 / 240, timestep)));
  let frames: ReplayFrame[] = [];
  let cursorSeconds = 0;
  let playback = false;
  let recording = true;

  function record(frame: ReplayFrame) {
    if (!recording || playback) return;
    frames.push(frame);
    if (frames.length > capacity) frames.shift();
  }

  function tick(dt: number) {
    if (!playback) return;
    cursorSeconds = Math.min(duration(), cursorSeconds + Math.max(0, dt));
    if (cursorSeconds >= duration()) {
      playback = false;
      recording = true;
    }
  }

  // The timeline is the frame index, one physics step per frame - NOT the
  // race clock in each frame's telemetry. The race clock stands still before
  // lights out and jumps forward when a time penalty is added, and a timeline
  // built on it collapsed every pre-start frame onto one instant and skipped
  // across penalties. It also has to match the AI's pose rings (see
  // lib/race/poseRing.ts), which are step-indexed.
  function duration(): number {
    return frames.length < 2 ? 0 : (frames.length - 1) * timestep;
  }

  function togglePlayback(): boolean {
    if (frames.length < 2) return false;
    if (!playback) {
      cursorSeconds = 0;
      playback = true;
      recording = false;
    } else {
      playback = false;
      recording = true;
    }
    return playback;
  }

  function stopPlayback() {
    playback = false;
    recording = true;
  }

  function seekRelative(seconds: number) {
    cursorSeconds = Math.min(duration(), Math.max(0, cursorSeconds + seconds));
  }

  /** How far behind the newest recorded frame the cursor sits - the shared
   * clock every other car's replay follows. Zero when not playing back. */
  function secondsBehindLive(): number {
    return playback ? Math.max(0, duration() - cursorSeconds) : 0;
  }

  /** The newest recorded frame: the live state at the moment playback began,
   * which is where the car must be put back when the replay ends. */
  function liveFrame(): ReplayFrame | null {
    return frames.length === 0 ? null : frames[frames.length - 1];
  }

  function frameAtCursor(): ReplayFrame | null {
    if (frames.length === 0) return null;
    if (!playback) return frames[frames.length - 1];
    const exact = cursorSeconds / timestep;
    const i = Math.min(frames.length - 1, Math.max(0, Math.floor(exact)));
    if (i >= frames.length - 1) return frames[frames.length - 1];
    return blendFrames(frames[i], frames[i + 1], exact - i);
  }

  function telemetryTrace(maxPoints = 80): TelemetryFrame[] {
    if (frames.length <= maxPoints) return frames.map((frame) => ({ ...frame.telemetry }));
    const stride = Math.ceil(frames.length / maxPoints);
    return frames.filter((_, index) => index % stride === 0).map((frame) => ({ ...frame.telemetry }));
  }

  function state(): ReplayState {
    return {
      recording,
      playback,
      cursorSeconds,
      durationSeconds: duration(),
      frameCount: frames.length,
    };
  }

  function clear() {
    frames = [];
    cursorSeconds = 0;
    playback = false;
    recording = true;
  }

  return {
    record,
    tick,
    togglePlayback,
    stopPlayback,
    seekRelative,
    secondsBehindLive,
    liveFrame,
    frameAtCursor,
    telemetryTrace,
    state,
    clear,
  };
}

function blendFrames(a: ReplayFrame, b: ReplayFrame, t: number): ReplayFrame {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  const qDot = a.rotation.x * b.rotation.x + a.rotation.y * b.rotation.y + a.rotation.z * b.rotation.z + a.rotation.w * b.rotation.w;
  const sign = qDot < 0 ? -1 : 1;
  const q = {
    x: lerp(a.rotation.x, sign * b.rotation.x),
    y: lerp(a.rotation.y, sign * b.rotation.y),
    z: lerp(a.rotation.z, sign * b.rotation.z),
    w: lerp(a.rotation.w, sign * b.rotation.w),
  };
  const qLen = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  q.x /= qLen;
  q.y /= qLen;
  q.z /= qLen;
  q.w /= qLen;
  return {
    position: {
      x: lerp(a.position.x, b.position.x),
      y: lerp(a.position.y, b.position.y),
      z: lerp(a.position.z, b.position.z),
    },
    rotation: q,
    linvel: {
      x: lerp(a.linvel.x, b.linvel.x),
      y: lerp(a.linvel.y, b.linvel.y),
      z: lerp(a.linvel.z, b.linvel.z),
    },
    angvel: {
      x: lerp(a.angvel.x, b.angvel.x),
      y: lerp(a.angvel.y, b.angvel.y),
      z: lerp(a.angvel.z, b.angvel.z),
    },
    telemetry: {
      elapsedSeconds: lerp(a.telemetry.elapsedSeconds, b.telemetry.elapsedSeconds),
      speedMs: lerp(a.telemetry.speedMs, b.telemetry.speedMs),
      throttle: lerp(a.telemetry.throttle, b.telemetry.throttle),
      brake: lerp(a.telemetry.brake, b.telemetry.brake),
      steer: lerp(a.telemetry.steer, b.telemetry.steer),
      gear: t < 0.5 ? a.telemetry.gear : b.telemetry.gear,
      rpm: lerp(a.telemetry.rpm, b.telemetry.rpm),
      batteryFraction: lerp(a.telemetry.batteryFraction, b.telemetry.batteryFraction),
      tireGrip: lerp(a.telemetry.tireGrip, b.telemetry.tireGrip),
      overtakeActive: t < 0.5 ? a.telemetry.overtakeActive : b.telemetry.overtakeActive,
      weather: t < 0.5 ? a.telemetry.weather : b.telemetry.weather,
    },
  };
}
