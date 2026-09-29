// Plan section 12 (Audio Design): fully synthesized race audio over the Web
// Audio API - zero sample assets, nothing to download. Every voice runs on
// the browser's audio thread, so the cost to the frame is the few
// parameter writes a tick below.
//
// - Engine: a V6 hybrid at its firing rate (see engineFrequencyHz) with a
//   smooth, mid-heavy harmonic spectrum, opened by the throttle, plus a
//   combustion-roar noise band and an MGU-K whine that swells on harvest.
//   Pitch follows the same rpm the HUD shift bar reads (see gearbox.ts).
// - Gearbox and lift-and-coast: an upshift drops the ignition for a few
//   hundredths, kicks back and clunks; a downshift blips the revs and
//   cracks; lifting off at speed lets the note fall away, whooshes the
//   turbo and crackles on the overrun.
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
  /** Chassis height, for effects placed at the car (sparks, spray). */
  y?: number;
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
  /** Monotonic player shift event counter, so audio never guesses from a
   * render-sampled gear delta. Remote/AI sources may leave this at zero. */
  shiftSerial: number;
  /** Pit-lane speed limiter engaged (player only): the cockpit beeps. */
  pitLimiter?: boolean;
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

/** The rpm the note is voiced over. A real F1 V6 idles near 4,000 and the
 * sim's own floor (IDLE_RPM) is lower than that, so the audio window starts
 * higher: idling and crawling in first no longer sound like a tractor. */
export const AUDIO_LOW_RPM = 4200;
export const AUDIO_HIGH_RPM = 12000;

/** Oscillator fundamental: a V6 four-stroke fires three times a crank
 * revolution, evenly spaced, so the exhaust pulse train is periodic at the
 * firing rate itself - rpm/60 x 3, 210 Hz at the bottom of the window to
 * 600 Hz at the redline. */
export function engineFrequencyHz(rpm01: number): number {
  const rpm = AUDIO_LOW_RPM + clamp01(rpm01) * (AUDIO_HIGH_RPM - AUDIO_LOW_RPM);
  // Keep the fundamental in a musical, non-aliasing band even if a remote
  // snapshot reports a nonsensical normalized rpm.
  return Math.min(800, (rpm / 60) * 3);
}

/** Throttle opens the lowpass: coasting is duller, full power bright but
 * capped short of the harsh 4 kHz+ band. */
export function engineCutoffHz(rpm01: number, throttle01: number): number {
  return 800 + 3000 * clamp01(rpm01) * (0.3 + 0.7 * clamp01(throttle01));
}

/** Audible at idle, present under power, never a bed of noise. */
export function engineGain01(throttle01: number): number {
  return 0.035 + 0.125 * clamp01(throttle01);
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

/** Harmonic amplitudes over the firing frequency: a steeper-than-sawtooth tilt with
 * an exhaust-resonance hump around the 5th order and a held-back
 * fundamental, so the note is a smooth mid-range wail rather than a boomy
 * drone or a harsh pulse buzz. */
export function engineHarmonics(count = 30): number[] {
  const amps = [0];
  for (let n = 1; n <= count; n++) {
    const hump = 1 + 1.6 * Math.exp(-((n - 5) ** 2) / 14);
    amps.push(((n === 1 ? 0.5 : 1) * hump) / n ** 1.25);
  }
  return amps;
}

function softClipCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return curve;
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
  /** Jump the smoothed rpm to a new value - a gear change moves the note in
   * tens of milliseconds, not the ~100 ms glide of a throttle response. */
  snapRpm(rpm01: number): void;
  output: GainNode;
}

function makeEngineVoice(
  context: BaseAudioContext,
  destination: AudioNode,
  wave: PeriodicWave,
  noise: AudioBuffer,
  rich: boolean
): EngineVoice {
  const osc = context.createOscillator();
  osc.setPeriodicWave(wave);
  // Combustion irregularity: a few cents of slow wobble, so the note is an
  // engine and not a test tone. (A detuned second oscillator did this before
  // and beat audibly at ~0.5 Hz - a drone.)
  const wobble = context.createOscillator();
  wobble.frequency.value = 9;
  const wobbleDepth = context.createGain();
  wobbleDepth.gain.value = 5;
  wobble.connect(wobbleDepth);
  wobbleDepth.connect(osc.detune);
  const shaper = context.createWaveShaper();
  shaper.curve = softClipCurve(1.4);
  // The boom below the fundamental is the "low pitched drone": cut it.
  const highpass = context.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 130;
  highpass.Q.value = 0.7;
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 0.8;
  const gain = context.createGain();
  gain.gain.value = 0;
  osc.connect(shaper);
  shaper.connect(highpass);
  highpass.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  osc.start();
  wobble.start();

  let smoothedRpm01 = 0;
  // Combustion roar: broad noise around the third order.
  let roarFilter: BiquadFilterNode | null = null;
  let roarGain: GainNode | null = null;
  // MGU-K whine: a thin sine that climbs with the revs and swells while the
  // motor harvests (off the throttle), the sound of lift and coast.
  let whine: OscillatorNode | null = null;
  let whineGain: GainNode | null = null;
  if (rich) {
    const roar = context.createBufferSource();
    roar.buffer = noise;
    roar.loop = true;
    roarFilter = context.createBiquadFilter();
    roarFilter.type = "bandpass";
    roarFilter.Q.value = 0.8;
    roarGain = context.createGain();
    roarGain.gain.value = 0;
    roar.connect(roarFilter);
    roarFilter.connect(roarGain);
    roarGain.connect(gain);
    roar.start();
    whine = context.createOscillator();
    whine.type = "sine";
    whineGain = context.createGain();
    whineGain.gain.value = 0;
    whine.connect(whineGain);
    whineGain.connect(gain);
    whine.start();
  }

  return {
    output: gain,
    snapRpm(rpm01) {
      smoothedRpm01 = clamp01(rpm01);
    },
    setState(rpm01, throttle01, gainScale, pitch, when, limiter01 = 0, holdGain = false) {
      smoothedRpm01 = smoothRpm01(smoothedRpm01, rpm01);
      const limiter = clamp01(limiter01);
      const throttle = clamp01(throttle01);
      const freq = engineFrequencyHz(smoothedRpm01) * pitch;
      osc.frequency.setTargetAtTime(freq, when, 0.02);
      filter.frequency.setTargetAtTime(engineCutoffHz(smoothedRpm01, throttle), when, 0.05);
      if (!holdGain) {
        const limiterCut = 1 - 0.2 * limiter;
        gain.gain.setTargetAtTime(engineGain01(throttle) * gainScale * limiterCut, when, 0.05);
      }
      if (roarFilter && roarGain) {
        roarFilter.frequency.setTargetAtTime(freq * 3, when, 0.04);
        roarGain.gain.setTargetAtTime(
          0.6 * throttle * (0.3 + smoothedRpm01) * (1 - 0.25 * limiter),
          when,
          0.06
        );
      }
      if (whine && whineGain) {
        whine.frequency.setTargetAtTime((1300 + 1500 * smoothedRpm01) * pitch, when, 0.05);
        // Quiet under power (deploy), clearly there off the throttle (harvest).
        whineGain.gain.setTargetAtTime(
          gainScale * (0.01 * smoothedRpm01 + 0.03 * (1 - throttle) * smoothedRpm01 ** 2),
          when,
          0.08
        );
      }
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
export function createRaceAudio(offline?: OfflineAudioContext): RaceAudioEngine | null {
  // `offline` lets a test render the mix to samples instead of the speakers;
  // it has no user-gesture gate and no realtime clock to wait for.
  let context: BaseAudioContext;
  if (offline) {
    context = offline;
  } else {
    if (typeof window === "undefined") return null;
    const Context =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return null;
    context = new Context();
  }
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -16;
  compressor.knee.value = 12;
  compressor.ratio.value = 4;
  const master = context.createGain();
  master.gain.value = MASTER_GAIN;
  // Nothing in the mix is worth hearing past 6.5 kHz, and the saturated
  // engine and noise bursts are exactly what makes it tiring there.
  const tame = context.createBiquadFilter();
  tame.type = "lowpass";
  tame.frequency.value = 6500;
  tame.Q.value = 0.5;
  master.connect(tame);
  tame.connect(compressor);
  compressor.connect(context.destination);

  const noise = makeNoiseBuffer(context);
  const imag = new Float32Array(engineHarmonics());
  const wave = context.createPeriodicWave(new Float32Array(imag.length), imag);
  const playerVoice = makeEngineVoice(context, master, wave, noise, true);

  // Rival voices: each its own pan, and a shared per-voice gain for the
  // distance fade (the engine voice's own gain carries the throttle).
  const FULL_ENGINE_GAIN = engineGain01(1);
  const rivals = Array.from({ length: OPPONENT_VOICES }, () => {
    const pan = context.createStereoPanner();
    pan.connect(master);
    return { pan, voice: makeEngineVoice(context, pan, wave, noise, false), car: -1 };
  });
  let voiced: number[] = [];

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
  let lastGear = 1;
  let lastPopAt = 0;
  let shiftCutUntil = 0;
  let lastThrottle = 0;
  let liftAt = -Infinity;
  let blipAt = -Infinity;
  let lastUpdateAt = 0;
  let lastBeepAt = -Infinity;

  /** Turbo/exhaust spool-down whistle after a lift: a thin sine falling away. */
  const spoolDown = (startHz: number, seconds: number, peak: number) => {
    const when = context.currentTime;
    const whistle = context.createOscillator();
    whistle.type = "sine";
    whistle.frequency.setValueAtTime(startHz, when);
    whistle.frequency.exponentialRampToValueAtTime(startHz * 0.35, when + seconds);
    const gain = context.createGain();
    gain.gain.setValueAtTime(peak, when);
    gain.gain.exponentialRampToValueAtTime(0.0005, when + seconds);
    whistle.connect(gain);
    gain.connect(master);
    whistle.start(when);
    whistle.stop(when + seconds + 0.05);
  };

  /** A short filtered noise burst - impacts, shift cracks, exhaust pops. */
  const burst = (
    gainPeak: number,
    cutoffHz: number,
    seconds: number,
    rate = 0.8,
    type: BiquadFilterType = "lowpass"
  ) => {
    const when = context.currentTime;
    const source = context.createBufferSource();
    source.buffer = noise;
    source.playbackRate.value = rate + Math.random() * 0.3;
    const filter = context.createBiquadFilter();
    filter.type = type;
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

  return {
    update(snapshot) {
      if (!offline && context.state !== "running") return;
      const when = context.currentTime;
      const p = snapshot.player;
      const speed = Math.hypot(p.vx, p.vz);

      const dt = Math.min(0.1, Math.max(0, when - lastUpdateAt));
      lastUpdateAt = when;

      // Shift events fire once per shiftSerial increment, and the gear number
      // gives the direction. An upshift is the seamless-shift ignition cut:
      // the engine drops out for a few hundredths, the note falls a gear's
      // worth, torque kicks back in and the box clunks. A downshift is the
      // auto-blip: the revs flare to the lower gear with a crack.
      if (p.shiftSerial > lastShiftSerial) {
        const g = playerVoice.output.gain;
        const level = engineGain01(p.throttle01);
        playerVoice.snapRpm(p.rpm01);
        if (p.gear > lastGear) {
          const cut = p.throttle01 > 0.3 ? 0.1 : 0.6;
          g.cancelScheduledValues(when);
          g.setValueAtTime(g.value, when);
          g.linearRampToValueAtTime(level * cut, when + 0.02);
          g.setValueAtTime(level * cut, when + 0.055);
          g.linearRampToValueAtTime(level * 1.3, when + 0.08);
          g.linearRampToValueAtTime(level, when + 0.2);
          shiftCutUntil = when + 0.2;
          burst(0.5, 320, 0.1, 0.4);
          burst(0.3, 2400, 0.05, 1.1, "bandpass");
        } else if (p.gear < lastGear) {
          g.cancelScheduledValues(when);
          g.setValueAtTime(g.value, when);
          g.linearRampToValueAtTime(level * 1.3, when + 0.02);
          g.linearRampToValueAtTime(level, when + 0.14);
          shiftCutUntil = when + 0.14;
          blipAt = when;
          burst(0.45, 2000 + Math.random() * 600, 0.07, 0.9, "bandpass");
          burst(0.4, 280, 0.09, 0.4);
        }
        lastShiftSerial = Math.max(lastShiftSerial, p.shiftSerial);
      }
      lastGear = p.gear;
      // The rev-match flare decays over ~0.1 s.
      const blip = 1 + 0.12 * Math.exp(-(when - blipAt) / 0.05);
      playerVoice.setState(
        p.rpm01,
        p.throttle01,
        1,
        blip,
        when,
        p.limiter01,
        when < shiftCutUntil
      );

      // Pit limiter: the same steady cockpit beep as the real car's.
      if (p.pitLimiter && when - lastBeepAt >= 0.6) {
        lastBeepAt = when;
        const beep = context.createOscillator();
        beep.frequency.value = 1000;
        const beepGain = context.createGain();
        beepGain.gain.setValueAtTime(0.05, when);
        beepGain.gain.setValueAtTime(0.05, when + 0.09);
        beepGain.gain.linearRampToValueAtTime(0, when + 0.11);
        beep.connect(beepGain);
        beepGain.connect(master);
        beep.start(when);
        beep.stop(when + 0.12);
      }

      // Lift and coast: coming off the throttle at speed, the note drops away
      // with the engine gain (see engineGain01) and the turbo lets go.
      if (lastThrottle > 0.6 && p.throttle01 < 0.2 && p.rpm01 > 0.3 && speed > 20) {
        liftAt = when;
        burst(0.12 + 0.08 * p.rpm01, 3000, 0.4, 1, "bandpass");
        spoolDown(1900 + 1100 * p.rpm01, 0.7, 0.012);
      }
      lastThrottle = p.throttle01;

      // Overrun: off the throttle at revs the exhaust crackles and pops -
      // thickest just after the lift, then a sparse burble down the straight.
      if (p.throttle01 < 0.1 && p.rpm01 > 0.3 && speed > 15 && when - lastPopAt > 0.05) {
        const perSecond = (when - liftAt < 1.5 ? 9 : 3) * (0.4 + 0.6 * p.rpm01);
        if (Math.random() < perSecond * dt) {
          lastPopAt = when;
          burst(0.25 + Math.random() * 0.25, 700 + Math.random() * 1400, 0.04 + Math.random() * 0.06, 0.5, "bandpass");
          if (Math.random() < 0.4) burst(0.25, 250, 0.06, 0.4);
        }
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
      if (!offline && context.state !== "running") return;
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
      if (context.state === "suspended" && "resume" in context) void (context as AudioContext).resume();
    },
    dispose() {
      if ("close" in context) void (context as AudioContext).close();
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
