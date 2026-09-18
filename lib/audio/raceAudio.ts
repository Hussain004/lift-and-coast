// Plan section 12 (Audio Design): fully synthesized race audio - engine,
// tires, opponent and impacts - over the Web Audio API with zero sample
// assets, so it costs nothing to ship and nothing to download. Engine pitch
// tracks the same rpm the HUD shift bar reads (see gearbox.ts), tire
// screech tracks slid lateral velocity, and the opponent gets its own
// quieter engine panned by relative bearing (the plan's positional audio).
//
// Two deliberate limits. There is no true slip-angle signal anywhere in the
// vehicle model (see the note in lib/physics/vehicle.ts), so the screech is
// an arcade heuristic over lateral velocity, not a tire model readout -
// tuned to stay silent in normal cornering and speak only when the car
// slides. And there is no camera shake on impacts: the chase camera's
// unsmoothed construction is a fixed bug (see Scene.tsx), so collisions
// sell themselves through sound alone.
import { IDLE_RPM, REDLINE_RPM } from "../physics/gearbox";

export interface AudioCarSnapshot {
  /** 0-1 across the idle..redline band. */
  rpm01: number;
  /** 0-1 driver/AI throttle demand. */
  throttle01: number;
  /** 0-1 slide amount (see skidAmount01). */
  skid01: number;
  x: number;
  z: number;
  yawRad: number;
}

export interface AudioSnapshot {
  player: AudioCarSnapshot;
  opponent: AudioCarSnapshot;
  /** Normalized impact strength with a timestamp, or null when quiet. */
  impact: { strength01: number; atMs: number } | null;
}

export function defaultCarSnapshot(): AudioCarSnapshot {
  return { rpm01: 0, throttle01: 0, skid01: 0, x: 0, z: 0, yawRad: 0 };
}

export function defaultAudioSnapshot(): AudioSnapshot {
  return { player: defaultCarSnapshot(), opponent: defaultCarSnapshot(), impact: null };
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Engine rpm into the idle..redline 0-1 band the synth voices read. */
export function rpmTo01(rpm: number): number {
  return clamp01((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
}

/**
 * Slide amount from planar velocity: the raycast rig has no slip angle, so
 * screech keys off lateral velocity instead. Normal cornering keeps
 * velocity aligned with heading (lateral reads near zero even in fast
 * corners), so anything past the edge is genuinely sliding - parked and
 * straight-line driving are gated by the forward-speed floor.
 */
export function skidAmount01(lateralMs: number, forwardMs: number): number {
  if (Math.abs(forwardMs) < 8) return 0;
  return clamp01((Math.abs(lateralMs) - 2) / 6);
}

/** Sawtooth fundamental: idle rumble rising to a redline snarl. */
export function engineFrequencyHz(rpm01: number): number {
  return 65 + 235 * clamp01(rpm01);
}

/** Throttle opens the lowpass: coasting muted and dark, full power bright. */
export function engineCutoffHz(rpm01: number, throttle01: number): number {
  return 350 + 2600 * clamp01(rpm01) * (0.25 + 0.75 * clamp01(throttle01));
}

/** Audible at idle, present under power, never a bed of noise. */
export function engineGain01(throttle01: number): number {
  return 0.035 + 0.1 * clamp01(throttle01);
}

/** Audible slide hiss, full slide clearly over the engine. */
export function skidGain01(skid01: number): number {
  return 0.16 * clamp01(skid01);
}

/** Opponent engine: clearly there in a fight, gone by ~100m. */
export function opponentGain01(distanceM: number): number {
  return 0.1 / (1 + Math.max(0, distanceM) / 30);
}

/**
 * Stereo position of the opponent relative to the player's heading: -1
 * hard left, +1 hard right, full pan once 8m off to the side.
 */
export function opponentPanLR(
  dx: number,
  dz: number,
  playerYawRad: number
): number {
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return 0;
  // Same convention as the minimap (see lib/tracks/minimap.ts): forward is
  // (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw).
  const rightX = Math.cos(playerYawRad);
  const rightZ = -Math.sin(playerYawRad);
  return Math.min(1, Math.max(-1, (dx * rightX + dz * rightZ) / Math.max(8, dist)));
}

/** Wheel taps stay quiet; chassis-scale hits land hard. */
export function impactGain01(impactForceN: number): number {
  return clamp01((impactForceN - 3000) / 42000);
}

export interface RaceAudioEngine {
  update(snapshot: AudioSnapshot): void;
  impact(strength01: number): void;
  setMuted(muted: boolean): void;
  muted(): boolean;
  resume(): void;
  dispose(): void;
}

function makeNoiseBuffer(context: BaseAudioContext): AudioBuffer {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function makeEngineVoice(
  context: BaseAudioContext,
  destination: AudioNode
): {
  setState(rpm01: number, throttle01: number, gainScale: number, when: number): void;
  output: GainNode;
} {
  const oscA = context.createOscillator();
  oscA.type = "sawtooth";
  const oscB = context.createOscillator();
  oscB.type = "sawtooth";
  oscB.detune.value = 7;
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  const gain = context.createGain();
  gain.gain.value = 0;
  oscA.connect(filter);
  oscB.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  oscA.start();
  oscB.start();
  return {
    output: gain,
    setState(rpm01, throttle01, gainScale, when) {
      const freq = engineFrequencyHz(rpm01);
      oscA.frequency.setTargetAtTime(freq, when, 0.045);
      oscB.frequency.setTargetAtTime(freq * 1.5, when, 0.045);
      filter.frequency.setTargetAtTime(engineCutoffHz(rpm01, throttle01), when, 0.06);
      gain.gain.setTargetAtTime(engineGain01(throttle01) * gainScale, when, 0.06);
    },
  };
}

/**
 * Null when there is no Web Audio (SSR, tests, ancient browsers) - callers
 * treat audio as simply absent rather than branching on environments.
 * Creation itself is cheap and silent; the context starts suspended until
 * resume() runs inside a user gesture (autoplay policy), so construct on
 * mount and resume on first input.
 */
export function createRaceAudio(): RaceAudioEngine | null {
  if (typeof window === "undefined") return null;
  const Context = window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const master = context.createGain();
  master.gain.value = 0.9;
  master.connect(context.destination);

  const noise = makeNoiseBuffer(context);
  // Opponent gain is expressed against this ceiling so the documented 0.1
  // maximum holds at full throttle point-blank.
  const FULL_ENGINE_GAIN = 0.035 + 0.1;
  const playerVoice = makeEngineVoice(context, master);
  const opponentPan = context.createStereoPanner();
  opponentPan.connect(master);
  const opponentVoice = makeEngineVoice(context, opponentPan);

  const skidSource = context.createBufferSource();
  skidSource.buffer = noise;
  skidSource.loop = true;
  const skidFilter = context.createBiquadFilter();
  skidFilter.type = "bandpass";
  skidFilter.frequency.value = 900;
  skidFilter.Q.value = 0.8;
  const skidGain = context.createGain();
  skidGain.gain.value = 0;
  skidSource.connect(skidFilter);
  skidFilter.connect(skidGain);
  skidGain.connect(master);
  skidSource.start();

  let muted = false;
  let lastImpactAt = -Infinity;

  return {
    update(snapshot) {
      if (context.state !== "running") return;
      const when = context.currentTime;
      playerVoice.setState(snapshot.player.rpm01, snapshot.player.throttle01, 1, when);
      skidGain.gain.setTargetAtTime(skidGain01(snapshot.player.skid01), when, 0.05);
      const dx = snapshot.opponent.x - snapshot.player.x;
      const dz = snapshot.opponent.z - snapshot.player.z;
      const dist = Math.hypot(dx, dz);
      opponentPan.pan.setTargetAtTime(
        opponentPanLR(dx, dz, snapshot.player.yawRad),
        when,
        0.08
      );
      opponentVoice.setState(
        snapshot.opponent.rpm01,
        snapshot.opponent.throttle01,
        opponentGain01(dist) / FULL_ENGINE_GAIN,
        when
      );
      if (snapshot.impact && snapshot.impact.atMs > lastImpactAt) {
        lastImpactAt = snapshot.impact.atMs;
        this.impact(snapshot.impact.strength01);
      }
    },
    impact(strength01) {
      if (context.state !== "running") return;
      const s = clamp01(strength01);
      if (s <= 0) return;
      const when = context.currentTime;
      const source = context.createBufferSource();
      source.buffer = noise;
      source.playbackRate.value = 0.6 + Math.random() * 0.3;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 400 + 2200 * s;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.5 * s, when);
      gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05 + 0.2 * s);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      source.start(when);
      source.stop(when + 0.3);
    },
    setMuted(next) {
      muted = next;
      master.gain.setTargetAtTime(next ? 0 : 0.9, context.currentTime, 0.03);
    },
    muted() {
      return muted;
    },
    resume() {
      if (context.state === "suspended") void context.resume();
    },
    dispose() {
      void context.close();
    },
  };
}

const AUDIO_KEY = "lift-and-coast.audio.v1";

function audioStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadMuted(
  storage: Pick<Storage, "getItem" | "setItem"> | null = audioStorage()
): boolean {
  try {
    return storage?.getItem(AUDIO_KEY) === "muted";
  } catch {
    return false;
  }
}

export function saveMuted(
  muted: boolean,
  storage: Pick<Storage, "getItem" | "setItem"> | null = audioStorage()
): void {
  try {
    storage?.setItem(AUDIO_KEY, muted ? "muted" : "live");
  } catch {
    // Non-fatal - worst case the next visit is unmuted.
  }
}
