/**
 * Offline renderer for the race audio sample bank.
 *
 * Run with: node --experimental-strip-types scripts/generate-audio.mts
 *
 * WHY THIS EXISTS
 * ---------------
 * The runtime synthesiser (lib/audio/raceAudio.ts) builds its whole engine
 * from a handful of Web Audio oscillators. That is cheap and needs no
 * downloads, but it cannot produce a realistic 1.6L V6 turbo, because the
 * things that make the engine recognisable are all things a handful of
 * oscillators cannot do:
 *
 *   - a genuinely rich exhaust spectrum (40+ harmonics with a load-dependent
 *     balance, not one fixed table),
 *   - per-cycle mechanical irregularity (real firing is never perfectly even,
 *     and that jitter is most of the "mechanical" character),
 *   - a fast, bright attack with a long decay, and
 *   - many overlapping, individually-modelled layers (combustion roar, exhaust
 *     resonance, turbo spool, MGU-K, transmission whine, blow-off, anti-lag).
 *
 * Rendering those OFFLINE is not just a quality upgrade - it is far cheaper
 * at runtime. The browser just crossfades and pitch-shifts buffers; it never
 * runs the model.
 *
 * The samples are generated rather than recorded, so there is no licensing
 * question and the bank is reproducible: this script IS the source of truth,
 * and re-running it regenerates byte-identical output.
 *
 * THE ONE THING THAT MATTERS MOST
 * -------------------------------
 * A four-stroke V6 fires THREE times per crank revolution, not one and a
 * half. The pre-existing runtime model used rpm/60 x 1.5 - exactly one
 * octave too low, which is most of why the engine sounded generic. Every
 * frequency in this script is derived from that firing rate:
 *
 *     firingHz = rpm / 60 * 3
 *
 * so idle (3000 rpm) is 150 Hz and redline (12000 rpm) is 600 Hz. Every
 * layer below is then a harmonic or a fixed multiple of that rate, exactly
 * as on the real engine.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = `${scriptDir}/../public/audio`;

/** Match the sim's own limits (lib/physics/gearbox.ts) so the bank and the
 *  rev range the engine can actually reach are the same range. */
const IDLE_RPM = 3000;
const REDLINE_RPM = 12000;
const SAMPLE_RATE = 32000;
/** Headroom for the runtime mix; nothing is allowed to clip. */
const PEAK_NORMALIZATION = 0.89;

// ---------------------------------------------------------------------------
// Deterministic noise
// ---------------------------------------------------------------------------

/** Mulberry32: small, fast, and seeded, so the bank is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// WAV encoding
// ---------------------------------------------------------------------------

function writeWav(path: string, samples: Float32Array, sampleRate: number): number {
  // Peak-normalise before quantising. The engine's level is set at runtime by
  // the mix, so what matters here is only that no file clips - a clipped
  // loop is a click, and a click every rotation is the single most obvious
  // "this is a synth" artefact there is.
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  const scale = peak > 0 ? PEAK_NORMALIZATION / peak : 1;
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM chunk size
  buffer.writeUInt16LE(1, 20); // format = PCM
  buffer.writeUInt16LE(1, 22); // channels
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(bytesPerSample, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] * scale));
    buffer.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), 44 + i * 2);
  }
  writeFileSync(path, buffer);
  return buffer.length;
}

// ---------------------------------------------------------------------------
// The engine model
// ---------------------------------------------------------------------------

/** Crank revolutions per second -> exhaust firing events per second. A
 *  four-stroke V6 has 6 cylinders each firing once every two revolutions, so
 *  3 firings per revolution. This is the number the entire engine hangs off. */
export function firingHzForRpm(rpm: number): number {
  return (rpm / 60) * 3;
}

/**
 * Exhaust harmonic spectrum for a load, as multipliers of the firing
 * frequency.
 *
 * Shape, in order of what it contributes to the sound:
 *  - a 1/k^0.8 rolloff, the natural spectrum of a sharp pressure pulse;
 *  - a bump around the 2nd/3rd harmonic. This is the "blade" of the V6 - the
 *    half-order-ish growl that sits under the top end and is what people
 *    actually recognise as "F1" rather than "engine";
 *  - a stronger bump near the firing frequency for the body;
 *  - load shaping: on throttle the high harmonics come up hard, off throttle
 *    they fall away and the note goes dull and lumpy. This single term is
 *    most of the difference between "on power" and "coasting".
 */
function exhaustSpectrum(load: number, out: Float64Array): void {
  const onLoad = Math.max(0, Math.min(1, load));
  for (let k = 1; k < out.length; k++) {
    // Steeper than the 1/k of a bare impulse. A real exhaust valve pulse is
    // fast but the pipe and the collector remove the top end; a slow
    // rolloff here is what made the first pass measure a 7kHz centroid and
    // sound like a cymbal rather than an engine.
    const pulse = Math.pow(k, -1.35);
    // High harmonics need combustion energy. Without this the engine sounds
    // the same at idle and at redline, which is the tell of a synth.
    const loadOnHigh = 0.06 + 0.94 * Math.pow(onLoad, 2.2);
    const loadOnLow = 0.4 + 0.6 * onLoad;
    const isHigh = k > 5;
    const blade = 1 + 0.8 * Math.exp(-(((k - 2.6) / 1.3) ** 2));
    const body = 1 + 0.5 * Math.exp(-(((k - 1) / 0.8) ** 2));
    out[k] = pulse * (isHigh ? loadOnHigh : loadOnLow) * blade * body;
  }
}

/**
 * Two-pole resonator used to band combustion noise around a centre frequency.
 * A plain one-pole lowpass on the noise (the first attempt) left a huge
 * rumble below 300Hz that buried the firing tone entirely.
 */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  private readonly a1: number;
  private readonly a2: number;
  private readonly norm: number;

  constructor(rate: number, hz: number, q: number) {
    const w = (2 * Math.PI * Math.min(hz, rate * 0.45)) / rate;
    const r = Math.exp(-w / (2 * q));
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -(r * r);
    // A two-pole resonator's gain at its own frequency is 1/(1-r). At Q=3.5
    // and 150Hz that is ~214x, so an unnormalised resonator fed white noise
    // produced a signal hundreds of times too loud: every file clipped, and
    // the noise buried the firing tone so completely the file measured as
    // broadband hiss with no peak at the firing rate at all. Normalising by
    // (1-r) makes the peak gain 1, so the resonator shapes noise without
    // changing its level.
    this.norm = 1 - r;
  }

  process(x: number): number {
    const y = this.norm * (x + this.a1 * this.y1 + this.a2 * this.y2);
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Box-smooth a per-cycle control curve, wrapping at the ends so the result
 *  is still exactly periodic over the loop. */
function circularSmooth(values: Float64Array, taps: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const half = Math.floor(taps / 2);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let t = -half; t <= half; t++) sum += values[(i + t + n * 2) % n];
    out[i] = sum / taps;
  }
  return out;
}

/**
 * One engine loop: the exhaust pulse train, combustion noise, and the
 * per-cycle jitter that stops it sounding like an organ.
 */
function renderEngine(opts: {
  rpm: number;
  load: number;
  seconds: number;
  seed: number;
}): Float32Array {
  const { rpm, load, seconds, seed } = opts;
  const random = rng(seed);
  const firing = firingHzForRpm(rpm);
  // The loop must be EXACTLY periodic, and that needs the cycle length
  // quantised before anything else is derived from it.
  //
  // SAMPLE_RATE/firing is 213.33 samples at idle and 53.33 at redline. If the
  // length is computed from the true (fractional) period while the per-cycle
  // modulation is indexed by a ROUNDED sample count, the two disagree by a
  // few samples per loop and the modulation jumps at the wrap - a click on
  // every rotation. So: quantise the cycle first, derive the frequency from
  // it, and make the length an exact multiple. The pitch error this
  // introduces is under 0.7% (603.8Hz instead of 600 at redline), which is
  // inaudible, and every component becomes exactly periodic.
  const cycleSamples = Math.max(2, Math.round(SAMPLE_RATE / firing));
  const quantisedFiring = SAMPLE_RATE / cycleSamples;
  const cycles = Math.max(1, Math.round(seconds * quantisedFiring));
  const length = cycles * cycleSamples;

  // Harmonics, capped below Nyquist with headroom.
  const maxHarmonic = Math.min(40, Math.floor(SAMPLE_RATE / (2.6 * quantisedFiring)));
  const amps = new Float64Array(maxHarmonic + 1);
  exhaustSpectrum(load, amps);
  // Fixed but not uniform phases: identical phases would make a flute-like
  // coherent tone, which is exactly the synthetic artefact to avoid.
  const phases = new Float64Array(maxHarmonic + 1);
  for (let k = 1; k <= maxHarmonic; k++) phases[k] = random() * Math.PI * 2;

  const out = new Float32Array(length);
  // Per-cycle mechanical irregularity. Real firing is never perfectly even:
  // compression varies, the crank breathes, the turbo pulses.
  //
  // This is pre-generated per FIRING CYCLE and circularly smoothed, which
  // fixes two things at once:
  //  - A phase that JUMPS at each cycle boundary multiplies the whole
  //    waveform by a phase step. That is a discontinuity, and a
  //    discontinuity is broadband: the first pass splattered energy from
  //    20Hz to Nyquist and the measured peak landed at 23Hz instead of the
  //    firing rate. Smoothing turns the step into a drift.
  //  - Because the modulation is a circular function of the cycle index, it
  //    is exactly periodic over the loop, so there is nothing to click at
  //    the wrap.
  const jitterRaw = circularSmooth(
    Float64Array.from({ length: cycles }, () => (random() - 0.5) * 0.006),
    6
  );
  // The jitter must sum to EXACTLY zero over the loop. Each cycle advances the
  // phase by 2*pi*(1 + jitter), so over `cycles` cycles the total is
  // 2*pi*cycles + 2*pi*sum(jitter) - and unless sum(jitter) is a whole number
  // the waveform arrives at the wrap with a fractional cycle of phase owed.
  // That is a step discontinuity, i.e. a click, once per loop. Removing the
  // mean makes the sum exactly zero and the loop close perfectly.
  let jitterMean = 0;
  for (let c = 0; c < cycles; c++) jitterMean += jitterRaw[c] / cycles;
  const jitter = Float64Array.from(jitterRaw, (v) => v - jitterMean);
  const levelMod = circularSmooth(
    Float64Array.from({ length: cycles }, () => 1 + (random() - 0.5) * 0.12),
    6
  );

  // Combustion noise, banded around the firing rate and its octave, the way
  // a real exhaust roar sits ON the firing tone rather than under it.
  const roarLow = new Resonator(SAMPLE_RATE, quantisedFiring, 3.5);
  const roarHigh = new Resonator(SAMPLE_RATE, quantisedFiring * 2.6, 5);

  // Seamlessness. Everything above is periodic in the loop because the loop
  // is a whole number of quantised firing cycles - EXCEPT the noise, which was
  // drawn from a running RNG and therefore jumped at the wrap. Pre-generating a
  // noise buffer makes the file one continuous periodic signal, but the repeat
  // count has to DIVIDE the loop exactly: floor(length/4) is not a divisor of
  // a length like 35145, and the leftover samples put a one-sample step at
  // the wrap. Pick the largest repeat count that divides cleanly, and the
  // noise is repeated over a quarter of the loop (~275ms) - far too short to
  // hear as a repeat.
  const repeats = [4, 3, 2, 1].find((r) => length % r === 0) ?? 1;
  const noisePeriod = length / repeats;
  const noiseBuf = new Float32Array(noisePeriod);
  for (let i = 0; i < noisePeriod; i++) noiseBuf[i] = random() * 2 - 1;

  let phase = 0;
  // One-pole DC blocker. The off-throttle burble term multiplies the signal by
  // (1 + a*sin(phase)), which is a real amplitude modulation and leaves a
  // measurable DC offset (~6% of peak). Inaudible in principle, but it is
  // free to remove and it would eat headroom.
  let dcX = 0;
  let dcY = 0;

  for (let i = 0; i < length; i++) {
    const cycle = Math.floor(i / cycleSamples) % cycles;
    // `phase` is in RADIANS, so a step must carry the 2*pi. Omitting it puts
    // the whole engine an octave-and-a-bit down at f/(2*pi) - 23.9Hz where
    // 150Hz belongs at idle, which measured as a slow wobble with no firing
    // tone in it at all.
    phase += (2 * Math.PI * quantisedFiring * (1 + jitter[cycle])) / SAMPLE_RATE;

    let s = 0;
    for (let k = 1; k <= maxHarmonic; k++) {
      s += amps[k] * Math.sin(k * phase + phases[k]);
    }
    // Normalise the harmonic sum so load, not harmonic count, sets loudness.
    s /= Math.sqrt(maxHarmonic);

    const n = noiseBuf[i % noisePeriod];
    const roar = roarLow.process(n) * (0.1 + 0.55 * load) + roarHigh.process(n) * (0.25 * load);

    // Off throttle the note is lumpier: amplitude modulated at the firing
    // rate, which is what an engine with uneven cylinder pressures does.
    const burble = load < 0.35 ? 1 + 0.3 * (1 - load / 0.35) * Math.sin(phase) : 1;

    const mixed = (s * 0.9 + roar * 0.5) * levelMod[cycle] * burble * 0.55;
    dcY = mixed - dcX + 0.995 * dcY;
    dcX = mixed;
    out[i] = dcY;
  }

  return out;
}

/**
 * The turbo. Not a tone: a real one is a wide, thin, slightly unstable
 * scream with the turbine and compressor tones beating against each other.
 */
function renderTurbo(opts: { shaftFraction: number; seconds: number; seed: number }): Float32Array {
  const { shaftFraction, seconds, seed } = opts;
  const random = rng(seed);

  // Turbo shaft is geared to the engine, so it is a fixed multiple of the
  // firing rate. This is the part people identify as "turbo" rather than
  // "engine", and it must move WITH rpm but not be locked to it.
  const shaftHz = firingHzForRpm(IDLE_RPM + shaftFraction * (REDLINE_RPM - IDLE_RPM)) * 26;
  // Same reasoning as the engine: quantise the period, then build the length
  // from it, so the whine completes a whole number of cycles per loop instead
  // of ending mid-cycle and clicking on every wrap.
  const periodSamples = Math.max(2, Math.round(SAMPLE_RATE / shaftHz));
  const quantisedShaft = SAMPLE_RATE / periodSamples;
  const repeats = Math.max(1, Math.round(SAMPLE_RATE * seconds / periodSamples));
  const length = repeats * periodSamples;
  const out = new Float32Array(length);

  const partials = [
    { ratio: 1, amp: 1.0 },
    { ratio: 2, amp: 0.32 },
    { ratio: 3, amp: 0.14 },
    { ratio: 4.01, amp: 0.07 },
    // Deliberate detune on the 4th: two rotors' tones beating is the
    // characteristic shimmer.
    { ratio: 5.02, amp: 0.05 },
  ];
  const phases = partials.map(() => random() * Math.PI * 2);
  const drift = 1 + (random() - 0.5) * 0.004;

  // Compressor hiss, also loop-periodic: a whole number of repeats that
  // divides the loop.
  const hissRepeats = [4, 3, 2, 1].find((r) => length % r === 0) ?? 1;
  const hissPeriod = length / hissRepeats;
  const hissBuf = new Float32Array(hissPeriod);
  for (let i = 0; i < hissPeriod; i++) hissBuf[i] = random() * 2 - 1;

  let phase = 0;
  let hiss = 0;
  for (let i = 0; i < length; i++) {
    // Radians: 2*pi per cycle, same as the engine (see renderEngine).
    phase += (2 * Math.PI * quantisedShaft * drift) / SAMPLE_RATE;
    let s = 0;
    partials.forEach((p, k) => {
      s += p.amp * Math.sin(p.ratio * phase + phases[k]);
    });
    // Compressor hiss riding on top. Reads from the pre-generated periodic
    // buffer, not the running RNG - the RNG is exhausted by the time this
    // loop finishes one pass, and a fresh draw per sample is neither
    // loop-periodic nor the same noise twice.
    const n = hissBuf[i % hissPeriod];
    hiss += (n - hiss) * 0.6;
    s += hiss * 0.25;
    out[i] = s * 0.22;
  }
  return out;
}

/**
 * Blow-off valve: pressure dumped on a lift, as a short descending hiss.
 *
 * Deliberately a mid-band hiss, not a whistle. This started at 6.1kHz and
 * played at up to 0.36 gain on every throttle lift, which produced exactly
 * the reported "high pitched sound that hurts my ears off throttle". A real
 * BOV is closer to a steam-release sigh than a squeal: the pitched content
 * lives below 3.5kHz and the energy is mostly broadband.
 */
function renderBov(): Float32Array {
  const length = Math.round(0.2 * SAMPLE_RATE);
  const out = new Float32Array(length);
  const random = rng(9001);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    // Falls fast, and stays well clear of the treble.
    const hz = 1900 * Math.exp(-3.2 * t) + 480;
    // Radians: 2*pi per cycle, same as the engine (see renderEngine).
    phase += (2 * Math.PI * hz) / SAMPLE_RATE;
    const env = Math.exp(-8 * t) * (1 - Math.exp(-t * 70));
    // Mostly noise: that is what makes it read as escaping air.
    const n = (random() * 2 - 1) * 0.85;
    out[i] = (n + Math.sin(phase) * 0.35) * env * 0.5;
  }
  return out;
}

/** A single anti-lag / overrun crack: exhaust firing off throttle. */
function renderCrack(seed: number, brightness: number): Float32Array {
  const length = Math.round(0.09 * SAMPLE_RATE);
  const out = new Float32Array(length);
  const random = rng(seed);
  let phase = 0;
  for (let i = 0; i < length; i++) {
    const t = i / length;
    const hz = 260 * (1 - 0.55 * t) + 90;
    // Radians: 2*pi per cycle, same as the engine (see renderEngine).
    phase += (2 * Math.PI * hz) / SAMPLE_RATE;
    const env = Math.exp(-16 * t) * (1 - Math.exp(-t * 400));
    const n = (random() * 2 - 1) * brightness;
    out[i] = (Math.sin(phase) * 0.6 + n) * env * 0.8;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bank
// ---------------------------------------------------------------------------

/** Engine load points, 0 = off throttle, 1 = full. */
const LOADS = [
  { name: "off", load: 0.12 },
  { name: "mid", load: 0.55 },
  { name: "on", load: 1 },
] as const;

/** rpm points the loops are crossfaded between. Equal-ish spacing in the
 *  log domain, because pitch perception is. */
const RPM_POINTS = [3000, 5000, 7000, 9000, 10800, 12000];

const TURBO_POINTS = [0, 0.5, 1];

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  const manifest: { file: string; kind: string; rpm?: number; load?: number; shaft?: number }[] = [];

  for (const rpm of RPM_POINTS) {
    for (const { name, load } of LOADS) {
      // Slightly longer loops at low rpm so every file covers a similar
      // number of firing cycles - otherwise the low-rpm loops would have a
      // noticeably coarser temporal grain than the top-end ones.
      const seconds = 1.1;
      const samples = renderEngine({ rpm, load, seconds, seed: rpm * 31 + load * 977 });
      const file = `engine-${rpm}-${name}.wav`;
      total += writeWav(`${OUT_DIR}/${file}`, samples, SAMPLE_RATE);
      manifest.push({ file, kind: "engine", rpm, load });
    }
  }

  for (const shaft of TURBO_POINTS) {
    const samples = renderTurbo({
      shaftFraction: shaft,
      seconds: 1.1,
      seed: 4242 + shaft * 7,
    });
    const file = `turbo-${Math.round(shaft * 100)}.wav`;
    total += writeWav(`${OUT_DIR}/${file}`, samples, SAMPLE_RATE);
    manifest.push({ file, kind: "turbo", shaft });
  }

  total += writeWav(`${OUT_DIR}/bov.wav`, renderBov(), SAMPLE_RATE);
  manifest.push({ file: "bov.wav", kind: "bov" });

  const cracks = [renderCrack(11, 0.5), renderCrack(29, 0.32), renderCrack(47, 0.7)];
  cracks.forEach((samples, i) => {
    const file = `crack-${i}.wav`;
    total += writeWav(`${OUT_DIR}/${file}`, samples, SAMPLE_RATE);
    manifest.push({ file, kind: "crack" });
  });

  writeFileSync(`${OUT_DIR}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `wrote ${manifest.length} files, ${(total / 1024 / 1024).toFixed(2)} MB to ${OUT_DIR}`
  );
  for (const rpm of RPM_POINTS) {
    console.log(
      `  ${String(rpm).padStart(5)} rpm -> firing ${firingHzForRpm(rpm).toFixed(1)} Hz`
    );
  }
}

main();
