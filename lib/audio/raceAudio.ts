// Plan section 12 (Audio Design): race audio over the Web Audio API.
//
// The engine, turbo and one-shots are GENERATED, not recorded - see
// scripts/generate-audio.mts, which is the source of truth for the
// public/audio/*.wav bank and can regenerate it byte-for-byte. That was a deliberate
// change from "zero sample assets": the engine used to be a handful of
// oscillators, and three things about it were simply wrong in a way no amount
// of mixing could fix - it was pitched an octave below the V6's real firing
// rate, its pitch was capped flat across the top of the rev range, and its
// "turbo" was a sine at 0.006 gain under a 0.16 engine, i.e. inaudible.
// Rendering the engine offline buys 40 load-dependent harmonics, per-cycle
// mechanical jitter and banded combustion roar for the price of a few hundred
// KB, and costs the browser nothing but two crossfades.
//
// Everything else (tyre squeal, wind, kerbs, impacts, the MGU-K whine) is
// still synthesised live, and every voice runs on the audio thread, so the
// cost to the frame is the few parameter writes a tick below.
//
// - Engine: a custom harmonic waveform tuned to a V6's firing order (a
//   half-order fundamental with a strong firing harmonic), soft-clipped for
//   grit, opened by the throttle, with a combustion-roar noise band, a
//   hybrid/turbo whine, overrun exhaust pops and a cut on every upshift.
//   Pitch follows the same rpm the HUD shift bar reads (see gearbox.ts).
// - Around it: speed-scaled wind, a kerb rumble pitched by speed, and a
//   two-band tyre squeal keyed off lateral slide (the rig has no slip-angle
//   signal - see skidAmount01).
// - Rivals: the three nearest cars each get an engine voice with distance
//   fade, stereo pan and Doppler.
import { IDLE_RPM, REDLINE_RPM, REV_LIMITER_RPM } from "../physics/gearbox";

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
  /** Planar velocity (Doppler, wind). */
  vx: number;
  vz: number;
  gear: number;
  /** Fraction of wheels on kerbs, 0-1. */
  kerb01: number;
  /** 0..1 limiter/load state derived from raw rpm; keeps the top gear from
   * sounding like a permanently flat, full-throttle tone. */
  limiter01: number;
  /**
   * 0..1 hybrid motor deployment, straight from the sim's energy system
   * (energyStatus.isDeploying). Drives the MGU-K whine, which is a large part
   * of a modern F1 engine note and did not exist here at all before.
   */
  deploy01?: number;
  /** Monotonic player shift event counter, so audio never guesses from a
   * render-sampled gear delta. Remote/AI sources may leave this at zero. */
  shiftSerial: number;
}

export interface AudioSnapshot {
  player: AudioCarSnapshot;
  /** One slot per rival (by aiIndex); null until that car reports. */
  opponents: (AudioCarSnapshot | null)[];
  /** Normalized impact strength with a timestamp, or null when quiet. */
  impact: { strength01: number; atMs: number } | null;
}

export function defaultCarSnapshot(): AudioCarSnapshot {
  return {
    rpm01: 0,
    throttle01: 0,
    skid01: 0,
    x: 0,
    z: 0,
    yawRad: 0,
    vx: 0,
    vz: 0,
    gear: 1,
    kerb01: 0,
    limiter01: 0,
    shiftSerial: 0,
  };
}

export function defaultAudioSnapshot(): AudioSnapshot {
  return { player: defaultCarSnapshot(), opponents: [], impact: null };
}

export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Engine rpm into the idle..redline 0-1 band the synth voices read. */
export function rpmTo01(rpm: number): number {
  return clamp01((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM));
}

/** Raw-rpm limiter/load amount. At redline this is zero; beyond it the
 * limiter rises smoothly instead of feeding the synth a hard-clipped,
 * full-gain tone. */
export function limiterAmount(rpm: number): number {
  if (rpm <= REDLINE_RPM) return 0;
  return clamp01((rpm - REDLINE_RPM) / (REV_LIMITER_RPM - REDLINE_RPM));
}

/** One-pole RPM smoothing for audio-rate control. The drivetrain already
 * filters shift decisions; this second, gentler filter removes render-rate
 * stair-steps and the last bit of top-gear beating without adding lag to a
 * genuine upshift (the target is allowed to rise quickly). */
export function smoothRpm01(current: number, target: number, alpha = 0.18): number {
  const t = clamp01(target);
  const c = clamp01(current);
  return c + (t - c) * clamp01(alpha);
}

/**
 * Slide amount from planar velocity: the raycast rig has no slip angle, so
 * the squeal keys off lateral velocity instead. Normal cornering keeps
 * velocity aligned with heading, so anything past the edge is genuinely
 * sliding - parked and straight-line driving are gated by the speed floor.
 */
export function skidAmount01(lateralMs: number, forwardMs: number): number {
  if (Math.abs(forwardMs) < 8) return 0;
  return clamp01((Math.abs(lateralMs) - 2) / 6);
}

/**
 * Engine fundamental.
 *
 * A four-stroke V6 has six cylinders, each firing once every two crank
 * revolutions, so the exhaust fires THREE times per revolution. That firing
 * rate is the real fundamental of the note: 150 Hz at this sim's 3000 rpm
 * idle and 600 Hz at its 12000 rpm redline.
 *
 * This used to be rpm/60 x 1.5 - exactly one octave low, with a 320Hz ceiling
 * on top that flattened the entire top of the rev range. Both were wrong, and
 * the pitch being an octave down is most of why the engine read as a generic
 * tone rather than an F1 V6. The generated sample bank (see
 * scripts/generate-audio.mts) is built on the same rule, and
 * tests/audioBank.test.ts pins it.
 */
export function engineFrequencyHz(rpm01: number): number {
  const rpm = IDLE_RPM + clamp01(rpm01) * (REDLINE_RPM - IDLE_RPM);
  return (rpm / 60) * 3;
}

/** The rpm the bank and this mapping both work in. */
export function rpmFor01(rpm01: number): number {
  return IDLE_RPM + clamp01(rpm01) * (REDLINE_RPM - IDLE_RPM);
}

/** The generated bank's rpm crossfade points, in the sim's own range. */
export const AUDIO_RPM_POINTS = [3000, 5000, 7000, 9000, 10800, 12000] as const;

/**
 * Which two bank loops to crossfade between for a given rpm, and by how much.
 * Returns the two indices and the position between them, 0..1.
 */
export function rpmBracket(rpm01: number): { lo: number; hi: number; t: number } {
  const rpm = rpmFor01(rpm01);
  const points = AUDIO_RPM_POINTS;
  if (rpm <= points[0]) return { lo: 0, hi: 0, t: 0 };
  const last = points.length - 1;
  if (rpm >= points[last]) return { lo: last, hi: last, t: 0 };
  let i = 0;
  while (i < last && rpm > points[i + 1]) i++;
  const span = points[i + 1] - points[i];
  return { lo: i, hi: i + 1, t: span > 0 ? (rpm - points[i]) / span : 0 };
}

/** Equal-power pair for a crossfade position. */
export function crossfadeWeights(t: number): [number, number] {
  const x = clamp01(t) * (Math.PI / 2);
  return [Math.cos(x), Math.sin(x)];
}

/** Throttle opens the lowpass: coasting muted and dark, full power bright. */
export function engineCutoffHz(rpm01: number, throttle01: number): number {
  return 500 + 3800 * clamp01(rpm01) * (0.3 + 0.7 * clamp01(throttle01));
}

/** Audible at idle, present under power, never a bed of noise. */
export function engineGain01(throttle01: number): number {
  return 0.05 + 0.11 * clamp01(throttle01);
}

/**
 * Turbo spool. Real turbo pressure lags the engine by a few hundred
 * milliseconds - that lag IS the turbo character, and feeding the whine
 * straight from rpm makes it sound like a sine oscillator bolted to the
 * engine. This is the one-pole coefficient for that lag, in the same
 * setTargetAtTime units the rest of the mix uses. Spooling up is quicker
 * than spooling down, because the wastegate dumps pressure far faster than
 * the turbine recovers it.
 */
export function turboLagCoefficient(spoolingUp: boolean): number {
  // The third argument to setTargetAtTime is a TIME CONSTANT, so larger is
  // slower. Spooling up is the quicker of the two; the wastegate dumps
  // pressure far faster than the turbine recovers it, so the way down is the
  // one that should lag.
  return spoolingUp ? 0.1 : 0.28;
}

/** Turbo level from the driver's right foot: nothing off throttle, loud on. */
export function turboGain01(throttle01: number, boost01: number): number {
  return 0.1 * clamp01(throttle01) * clamp01(boost01);
}

/**
 * MGU-K. The hybrid motor is a big part of why a modern F1 car sounds the way
 * it does, and it is a completely different sound to the engine: a thin,
 * slightly detuned electric whine a couple of octaves above the exhaust note.
 * Driven from the sim's real deployment state rather than guessed from
 * throttle, so it appears only when the driver is actually deploying.
 */
export function mguGain01(deploy01: number): number {
  return 0.055 * clamp01(deploy01);
}

/** MGU-K pitch, in Hz, against rpm. */
export function mguFrequencyHz(rpm01: number): number {
  return 1400 + 2100 * clamp01(rpm01);
}

/** Audible slide hiss, full slide clearly over the engine. */
export function skidGain01(skid01: number): number {
  return 0.18 * clamp01(skid01);
}

/** Wind rises with the square of speed: silent in the pits, a rush at
 * 300 km/h. */
export function windGain01(speedMs: number): number {
  return 0.13 * clamp01((Math.max(0, speedMs) / 85) ** 2);
}

/** Kerb stripes pass under the tyres about every metre: the rumble's pitch
 * is the speed in m/s, kept in the audible thump band. */
export function kerbRumbleHz(speedMs: number): number {
  return Math.min(95, Math.max(14, Math.abs(speedMs) / 1.1));
}

/** Opponent engine: clearly there in a fight, gone by ~150m. */
export function opponentGain01(distanceM: number): number {
  return 0.1 / (1 + Math.max(0, distanceM) / 30);
}

/**
 * Stereo position of a car relative to the player's heading: -1 hard left,
 * +1 hard right, full pan once 8m off to the side.
 */
export function opponentPanLR(dx: number, dz: number, playerYawRad: number): number {
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6) return 0;
  // Same convention as the minimap (see lib/tracks/minimap.ts): forward is
  // (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw).
  const rightX = Math.cos(playerYawRad);
  const rightZ = -Math.sin(playerYawRad);
  return Math.min(1, Math.max(-1, (dx * rightX + dz * rightZ) / Math.max(8, dist)));
}

/**
 * Doppler pitch factor for a source moving at `radialMs` away from the
 * listener (negative = approaching), exaggerated 1.6x so a pass reads
 * through small laptop speakers, and bounded.
 */
export function dopplerFactor(radialMs: number): number {
  const c = 343;
  const v = Math.max(-120, Math.min(120, radialMs * 1.6));
  return c / (c + v);
}

/** Wheel taps stay quiet; chassis-scale hits land hard. */
export function impactGain01(impactForceN: number): number {
  return clamp01((impactForceN - 3000) / 42000);
}

/**
 * The rivals that get a voice: the nearest `count` within earshot,
 * preferring the ones already voiced (so a pack doesn't make voices swap
 * cars every frame). Returns indices into `opponents`.
 */
export function pickVoicedOpponents(
  player: { x: number; z: number },
  opponents: readonly (AudioCarSnapshot | null)[],
  current: readonly number[],
  count: number,
  earshotM = 160
): number[] {
  const ranked: { i: number; d: number }[] = [];
  opponents.forEach((o, i) => {
    if (!o) return;
    const d = Math.hypot(o.x - player.x, o.z - player.z);
    // Hysteresis: a voiced car counts as 15m closer when ranking.
    if (d < earshotM) ranked.push({ i, d: current.includes(i) ? d - 15 : d });
  });
  ranked.sort((a, b) => a.d - b.d);
  return ranked.slice(0, count).map((r) => r.i);
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
  const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

interface EngineVoice {
  /** holdGain leaves the output gain alone (a scheduled shift cut owns it). */
  setState(
    rpm01: number,
    throttle01: number,
    gainScale: number,
    pitch: number,
    when: number,
    limiter01?: number,
    holdGain?: boolean
  ): void;
  output: GainNode;
}

/** Decoded bank: file stem -> buffer, plus the axes the loops are cut on. */
export interface AudioBank {
  get(name: string): AudioBuffer | undefined;
  rpm: readonly number[];
  loads: readonly string[];
}

/**
 * Load and decode the generated sample bank.
 *
 * Fetched in parallel and decoded once, then every voice crossfades between
 * already-decoded buffers - decoding on demand would stutter on the first
 * blip of throttle. A missing or unreadable file is not fatal: the bank is an
 * enhancement over a synthesised fallback, and a race that cannot start
 * because an asset 404'd would be a far worse outcome than a plainer engine.
 */
export async function loadAudioBank(
  context: BaseAudioContext,
  base = "/audio/"
): Promise<AudioBank> {
  const rpm = [...AUDIO_RPM_POINTS];
  const loads = ["off", "mid", "on"];
  const names = [
    ...rpm.flatMap((r) => loads.map((l) => `engine-${r}-${l}`)),
    "turbo-0",
    "turbo-50",
    "turbo-100",
    "bov",
    "crack-0",
    "crack-1",
    "crack-2",
  ];
  const buffers = new Map<string, AudioBuffer>();
  await Promise.all(
    names.map(async (name) => {
      try {
        const response = await fetch(`${base}${name}.wav`);
        if (!response.ok) return;
        buffers.set(name, await context.decodeAudioData(await response.arrayBuffer()));
      } catch {
        // Left absent; the voice simply has nothing to fade to.
      }
    })
  );
  return { get: (name) => buffers.get(name), rpm, loads };
}

/**
 * A sample-based engine voice.
 *
 * One looping buffer per (rpm point x load point) in the bank, equal-power
 * crossfaded between the two rpm brackets and the two load brackets. The
 * loops are the real thing (rendered offline by scripts/generate-audio.mts),
 * so all the things a handful of oscillators could not do - 40 load-dependent
 * harmonics, per-cycle mechanical jitter, banded combustion roar, the F1
 * firing rate - are already in the samples. The browser's whole job here is to
 * choose two of them and fade.
 *
 * Rivals use the same voice, so every car in the field is the same engine at
 * a different pitch and load, exactly as they should be.
 *
 * The gain matrix is built immediately but the sources are attached later, via
 * `attach(bank)` once the fetch and decode finish. Building them up front
 * would mean decoding on demand the first time the throttle moved, which is
 * precisely when a stutter would be most obvious.
 */
function makeSampleEngineVoice(
  context: BaseAudioContext,
  destination: AudioNode
): EngineVoice & { attach(bank: AudioBank): void } {
  const output = context.createGain();
  output.gain.value = 0;
  // A gentle lowpass the mix opens with load, so a distant car sits further
  // back without needing a separate sample set.
  const tone = context.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 12000;
  tone.Q.value = 0.6;
  tone.connect(output);
  output.connect(destination);

  // [loadIndex][rpmIndex] -> gain
  const LOAD_COUNT = 3;
  const gains: GainNode[][] = [];
  for (let li = 0; li < LOAD_COUNT; li++) {
    const row: GainNode[] = [];
    for (let ri = 0; ri < AUDIO_RPM_POINTS.length; ri++) {
      const g = context.createGain();
      g.gain.value = 0;
      g.connect(tone);
      row.push(g);
    }
    gains.push(row);
  }
  const attach = (bank: AudioBank): void => {
    for (let li = 0; li < LOAD_COUNT; li++) {
      const loadName = bank.loads[li] ?? bank.loads[0];
      for (let ri = 0; ri < AUDIO_RPM_POINTS.length; ri++) {
        const buffer = bank.get(`engine-${AUDIO_RPM_POINTS[ri]}-${loadName}`);
        if (!buffer) continue;
        const src = context.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.connect(gains[li][ri]);
        src.start();
      }
    }
  };

  let smoothedRpm01 = 0;
  let smoothedLoad01 = 0;
  return {
    output,
    attach,
    setState(rpm01, throttle01, gainScale, pitch, when, limiter01 = 0, holdGain = false) {
      smoothedRpm01 = smoothRpm01(smoothedRpm01, rpm01);
      // Load follows the throttle but slower, which is what makes a lift feel
      // like a moment rather than an instant.
      smoothedLoad01 = smoothRpm01(smoothedLoad01, throttle01, 0.25);

      const { lo, hi, t } = rpmBracket(smoothedRpm01);
      const [wLo, wHi] = crossfadeWeights(t);
      // Three bank load points, so two brackets.
      const loadPos = clamp01(smoothedLoad01) * (LOAD_COUNT - 1);
      const l0 = Math.min(LOAD_COUNT - 1, Math.floor(loadPos));
      const l1 = Math.min(LOAD_COUNT - 1, l0 + 1);
      const [lw0, lw1] = crossfadeWeights(loadPos - l0);

      for (let li = 0; li < LOAD_COUNT; li++) {
        for (let ri = 0; ri < AUDIO_RPM_POINTS.length; ri++) {
          const rpmWeight = ri === lo ? wLo : ri === hi ? wHi : 0;
          const loadWeight = li === l0 ? lw0 : li === l1 ? lw1 : 0;
          const g = gains[li][ri];
          g.gain.setTargetAtTime(rpmWeight * loadWeight, when, 0.04);
        }
      }

      if (!holdGain) {
        const limiterCut = 1 - 0.2 * clamp01(limiter01);
        output.gain.setTargetAtTime(
          engineGain01(throttle01) * gainScale * limiterCut,
          when,
          0.05
        );
      }
      tone.frequency.setTargetAtTime(
        engineCutoffHz(smoothedRpm01, throttle01) * pitch,
        when,
        0.06
      );
    },
  };
}

/**
 * The turbo, as its own voice with real spool lag. Two bank loops crossfaded
 * by a lagging boost value, so the whine arrives slightly after the power -
 * which is the single most recognisable thing about a turbocharged engine
 * after the firing rate itself.
 */
function makeTurboVoice(
  context: BaseAudioContext,
  destination: AudioNode
): { setState(boost01: number, rpm01: number, when: number): void; output: GainNode; attach(bank: AudioBank): void } {
  const output = context.createGain();
  output.gain.value = 0;
  output.connect(destination);
  const names = ["turbo-0", "turbo-50", "turbo-100"];
  const gains: GainNode[] = names.map(() => {
    const g = context.createGain();
    g.gain.value = 0;
    g.connect(output);
    return g;
  });
  const attach = (bank: AudioBank): void => {
    names.forEach((name, i) => {
      const buffer = bank.get(name);
      if (!buffer) return;
      const src = context.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.connect(gains[i]);
      src.start();
    });
  };
  // Spool state, lagged.
  let boost = 0;
  let previousBoost = 0;
  return {
    output,
    attach,
    setState(boost01, rpm01, when) {
      previousBoost = boost;
      boost = clamp01(boost01);
      const lag = turboLagCoefficient(boost >= previousBoost);
      const pos = boost * (gains.length - 1);
      const i0 = Math.min(gains.length - 1, Math.floor(pos));
      const i1 = Math.min(gains.length - 1, i0 + 1);
      const [w0, w1] = crossfadeWeights(pos - i0);
      gains.forEach((g, i) => {
        const w = i === i0 ? w0 : i === i1 ? w1 : 0;
        g.gain.setTargetAtTime(w, when, lag);
      });
      // Also fades out at the very top of the range, where the real car is
      // on the limiter and the engine, not the turbo, is what you hear.
      output.gain.setTargetAtTime(
        0.5 * (0.55 + 0.45 * clamp01(rpm01)),
        when,
        lag
      );
    },
  };
}

/**
 * MGU-K: two detuned sines through a bandpass, gated on the sim's real
 * deployment state. Cheap, and correct - it is a pure electrical whine, not
 * something a sample loop of combustion would capture.
 */
function makeMguVoice(context: BaseAudioContext, destination: AudioNode) {
  const output = context.createGain();
  output.gain.value = 0;
  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 2000;
  filter.Q.value = 2.4;
  filter.connect(output);
  output.connect(destination);
  const a = context.createOscillator();
  const b = context.createOscillator();
  a.type = "sine";
  b.type = "sine";
  a.connect(filter);
  b.connect(filter);
  a.start();
  b.start();
  return {
    setState(deploy01: number, rpm01: number, when: number) {
      const f = mguFrequencyHz(rpm01);
      a.frequency.setTargetAtTime(f, when, 0.05);
      // The two inverter halves never sit at exactly the same frequency; the
      // beat between them is most of the character.
      b.frequency.setTargetAtTime(f * 1.011, when, 0.05);
      filter.frequency.setTargetAtTime(f * 1.1, when, 0.05);
      output.gain.setTargetAtTime(mguGain01(deploy01), when, deploy01 > 0.05 ? 0.04 : 0.12);
    },
  };
}

const OPPONENT_VOICES = 3;
const MASTER_GAIN = 0.9;

/**
 * Null when there is no Web Audio (SSR, tests, ancient browsers) - callers
 * treat audio as simply absent rather than branching on environments.
 * Creation itself is cheap and silent; the context starts suspended until
 * resume() runs inside a user gesture (autoplay policy), so construct on
 * mount and resume on first input.
 */
export function createRaceAudio(): RaceAudioEngine | null {
  if (typeof window === "undefined") return null;
  const Context =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  master.connect(compressor);
  compressor.connect(context.destination);

  const noise = makeNoiseBuffer(context);

  const playerVoice = makeSampleEngineVoice(context, master);
  const turbo = makeTurboVoice(context, master);
  const mgu = makeMguVoice(context, master);

  // Rival voices: each its own pan, and a shared per-voice gain for the
  // distance fade (the engine voice's own gain carries the throttle).
  const FULL_ENGINE_GAIN = engineGain01(1);
  const rivals = Array.from({ length: OPPONENT_VOICES }, () => {
    const pan = context.createStereoPanner();
    pan.connect(master);
    return { pan, voice: makeSampleEngineVoice(context, pan), car: -1 };
  });
  let voiced: number[] = [];

  // One fetch for every voice. Until it resolves the engine and turbo are
  // simply silent - the context is still suspended at this point (autoplay
  // policy) and the player cannot have moved the car yet, so the gap is not
  // audible in practice. A missing file degrades to a quieter car rather than
  // a race that will not start.
  // Fire and forget: every voice is silent until its buffers land.
  void loadAudioBank(context).then((bank) => {
    playerVoice.attach(bank);
    turbo.attach(bank);
    for (const slot of rivals) slot.voice.attach(bank);
    oneShots.bank = bank;
  });

  const loopNoise = (type: BiquadFilterType, freq: number, q: number): { gain: GainNode; filter: BiquadFilterNode } => {
    const src = context.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const filter = context.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = context.createGain();
    gain.gain.value = 0;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start();
    return { gain, filter };
  };
  const squealLow = loopNoise("bandpass", 1150, 5);
  const squealHigh = loopNoise("bandpass", 2350, 4);
  const wind = loopNoise("lowpass", 500, 0.5);

  const rumble = context.createOscillator();
  rumble.type = "square";
  const rumbleFilter = context.createBiquadFilter();
  rumbleFilter.type = "lowpass";
  rumbleFilter.frequency.value = 220;
  const rumbleGain = context.createGain();
  rumbleGain.gain.value = 0;
  rumble.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(master);
  rumble.start();

  let muted = false;
  let lastImpactAt = -Infinity;
  let lastShiftSerial = 0;
  let lastPopAt = 0;
  let shiftCutUntil = 0;
  /** Where the one-shot buffers live once the bank lands. */
  const oneShots: { bank?: AudioBank } = {};

  /** A short filtered noise burst - impacts and shift cracks. */
  const burst = (gainPeak: number, cutoffHz: number, seconds: number, rate = 0.8) => {
    const when = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = rate + Math.random() * 0.3;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoffHz;
    const gain = context.createGain();
    gain.gain.setValueAtTime(gainPeak, when);
    gain.gain.exponentialRampToValueAtTime(0.0005, when + seconds);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(when, Math.random() * 1.5);
    source.stop(when + seconds + 0.05);
  };

  /** Play a generated one-shot (blow-off valve, anti-lag crack). */
  const oneShot = (name: string, peak: number, rate = 1) => {
    const buffer = oneShots.bank?.get(name);
    if (!buffer) return;
    const when = context.currentTime;
    const src = context.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = context.createGain();
    gain.gain.setValueAtTime(peak, when);
    gain.gain.exponentialRampToValueAtTime(0.0005, when + buffer.duration);
    src.connect(gain);
    gain.connect(master);
    src.start(when);
    src.stop(when + buffer.duration + 0.02);
  };

  let previousThrottle = 0;

  return {
    update(snapshot) {
      if (context.state !== "running") return;
      const when = context.currentTime;
      const p = snapshot.player;
      const speed = Math.hypot(p.vx, p.vz);

      // Upshift: the ignition cut dips the engine for a few hundredths and
      // the exhaust cracks.
      if (p.shiftSerial > lastShiftSerial && p.throttle01 > 0.3) {
        const g = playerVoice.output.gain;
        g.cancelScheduledValues(when);
        g.setValueAtTime(g.value, when);
        g.linearRampToValueAtTime(g.value * 0.25, when + 0.025);
        g.linearRampToValueAtTime(engineGain01(p.throttle01), when + 0.09);
        shiftCutUntil = when + 0.09;
        burst(0.22, 2200, 0.08, 1.1);
      }
      lastShiftSerial = Math.max(lastShiftSerial, p.shiftSerial);
      playerVoice.setState(
        p.rpm01,
        p.throttle01,
        1,
        1,
        when,
        p.limiter01,
        when < shiftCutUntil
      );

      // Lift-off: a hard lift off boost is where a real turbo dumps pressure -
      // the blow-off valve chirp, then the anti-lag cracks that hold the boost
      // up on the way back down. Both were missing entirely before, and they
      // are a large part of why an on-throttle/off-throttle F1 engine sounds
      // like a machine rather than a recording.
      const lifted = previousThrottle > 0.45 && p.throttle01 < 0.12;
      if (lifted && p.rpm01 > 0.3) {
        oneShot("bov", 0.16 + 0.2 * p.rpm01, 0.95 + Math.random() * 0.12);
        // A short burst of cracks, tightening as the revs fall.
        for (let k = 0; k < 3; k++) {
          const crack = 0.06 + Math.random() * 0.09;
          window.setTimeout(() => {
            if (context.state === "running") {
              oneShot(`crack-${Math.floor(Math.random() * 3)}`, crack, 0.85 + Math.random() * 0.3);
            }
          }, 40 + k * (55 + Math.random() * 60));
        }
      }
      previousThrottle = p.throttle01;

      // Turbo: spooled by the right foot, with the voice's own lag.
      turbo.setState(p.throttle01, p.rpm01, when);
      // MGU-K: only when the sim says the hybrid is actually deploying.
      mgu.setState(p.deploy01 ?? 0, p.rpm01, when);

      // Overrun: off the throttle at high revs the exhaust pops and bangs.
      if (p.throttle01 < 0.08 && p.rpm01 > 0.45 && speed > 20 && when - lastPopAt > 0.07 && Math.random() < 0.18) {
        lastPopAt = when;
        oneShot(`crack-${Math.floor(Math.random() * 3)}`, 0.1 + Math.random() * 0.12, 0.5 + Math.random() * 0.2);
      }

      squealLow.gain.gain.setTargetAtTime(skidGain01(p.skid01), when, 0.05);
      squealHigh.gain.gain.setTargetAtTime(skidGain01(p.skid01) * 0.55, when, 0.05);
      squealLow.filter.frequency.setTargetAtTime(1050 + 250 * p.skid01, when, 0.1);
      wind.gain.gain.setTargetAtTime(windGain01(speed), when, 0.2);
      wind.filter.frequency.setTargetAtTime(350 + speed * 18, when, 0.2);
      rumble.frequency.setTargetAtTime(kerbRumbleHz(speed), when, 0.05);
      rumbleGain.gain.setTargetAtTime(p.kerb01 > 0 && speed > 5 ? 0.09 * p.kerb01 + 0.05 : 0, when, 0.03);

      // Rivals: nearest three, with pan, distance fade and Doppler.
      voiced = pickVoicedOpponents(p, snapshot.opponents, voiced, OPPONENT_VOICES);
      rivals.forEach((slot, k) => {
        const index = voiced[k];
        const o = index === undefined ? null : snapshot.opponents[index];
        if (!o) {
          slot.voice.output.gain.setTargetAtTime(0, when, 0.15);
          return;
        }
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        const dist = Math.hypot(dx, dz);
        const radial = dist > 1e-3 ? ((o.vx - p.vx) * dx + (o.vz - p.vz) * dz) / dist : 0;
        // A voice moving to a different car fades across rather than jumping.
        const settle = slot.car === index ? 0.08 : 0.25;
        slot.car = index;
        slot.pan.pan.setTargetAtTime(opponentPanLR(dx, dz, p.yawRad), when, settle);
        slot.voice.setState(
          o.rpm01,
          o.throttle01,
          opponentGain01(dist) / FULL_ENGINE_GAIN,
          dopplerFactor(radial),
          when,
          o.limiter01
        );
      });

      if (snapshot.impact && snapshot.impact.atMs > lastImpactAt) {
        lastImpactAt = snapshot.impact.atMs;
        this.impact(snapshot.impact.strength01);
      }
    },
    impact(strength01) {
      if (context.state !== "running") return;
      const s = clamp01(strength01);
      if (s <= 0) return;
      burst(0.55 * s, 400 + 2200 * s, 0.06 + 0.22 * s, 0.6);
    },
    setMuted(next) {
      muted = next;
      master.gain.setTargetAtTime(next ? 0 : MASTER_GAIN, context.currentTime, 0.03);
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

export function loadMuted(storage: Pick<Storage, "getItem" | "setItem"> | null = audioStorage()): boolean {
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
