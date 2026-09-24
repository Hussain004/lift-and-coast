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

/**
 * A compact rolling replay/telemetry recorder. It deliberately stores the
 * same physics snapshot as rewind plus a small telemetry row, so instant
 * replay and the data trace cannot disagree about what the car was doing.
 */
export function createReplayController(
  capacitySeconds = 45,
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

  function duration(): number {
    if (frames.length < 2) return 0;
    return Math.max(0, frames[frames.length - 1].telemetry.elapsedSeconds - frames[0].telemetry.elapsedSeconds);
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

  function frameAtCursor(): ReplayFrame | null {
    if (frames.length === 0) return null;
    if (!playback) return frames[frames.length - 1];
    const target = frames[0].telemetry.elapsedSeconds + cursorSeconds;
    if (target <= frames[0].telemetry.elapsedSeconds) return frames[0];
    const last = frames[frames.length - 1];
    if (target >= last.telemetry.elapsedSeconds) return last;
    for (let i = 1; i < frames.length; i++) {
      const b = frames[i];
      if (target > b.telemetry.elapsedSeconds) continue;
      const a = frames[i - 1];
      const span = b.telemetry.elapsedSeconds - a.telemetry.elapsedSeconds;
      const t = span <= 0 ? 0 : (target - a.telemetry.elapsedSeconds) / span;
      return blendFrames(a, b, t);
    }
    return last;
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

  return { record, tick, togglePlayback, stopPlayback, seekRelative, frameAtCursor, telemetryTrace, state, clear };
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
