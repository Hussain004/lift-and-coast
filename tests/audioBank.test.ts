import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The generated audio bank is the engine, so its measurable properties are
 * worth pinning down. This cannot listen - but every one of the failures
 * below was a real defect that was invisible by ear alone and obvious by
 * measurement, and a future edit to the generator that reintroduces any of
 * them should fail here rather than in someone's headphones.
 *
 * Specifically, this is what caught:
 *  - a phase increment missing its 2*pi, which put the whole engine at
 *    f/(2*pi) - 23.9Hz where 150Hz belongs at idle, and
 *  - per-cycle pitch jitter that did not sum to zero, which left a fractional
 *    cycle of phase owed at every loop wrap, i.e. a click once per loop.
 */

const AUDIO_DIR = join(process.cwd(), "public", "audio");

/** A four-stroke V6 fires three times per crank revolution. */
function firingHz(rpm: number): number {
  return (rpm / 60) * 3;
}

function readWav(name: string): { data: Float32Array; rate: number } {
  const b = readFileSync(join(AUDIO_DIR, name));
  const rate = b.readUInt32LE(24);
  const n = (b.length - 44) / 2;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = b.readInt16LE(44 + i * 2) / 32768;
  return { data, rate };
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const br = re[i + k + len / 2], bi = im[i + k + len / 2];
        const vr = br * cr - bi * ci;
        const vi = br * ci + bi * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

const SIZE = 16384;

interface Analysis {
  peakHz: number;
  centroidHz: number;
  bandShare: { low: number; mid: number; high: number; air: number };
  peak: number;
  seamStep: number;
  typicalStep: number;
}

function analyse(name: string): Analysis {
  const { data, rate } = readWav(name);
  const start = Math.max(0, Math.floor(data.length / 2) - SIZE / 2);
  const re = new Float64Array(SIZE);
  const im = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
    re[i] = (data[start + i] ?? 0) * (0.5 * (1 - Math.cos((2 * Math.PI * i) / (SIZE - 1))));
  }
  fft(re, im);
  const half = SIZE >> 1;
  const binHz = rate / SIZE;
  const band = { low: 0, mid: 0, high: 0, air: 0 };
  let num = 0, den = 0, peak = 0, peakHz = 0;
  for (let i = 1; i < half; i++) {
    const hz = i * binHz;
    const m = Math.hypot(re[i], im[i]);
    num += m * hz; den += m;
    if (hz < 300) band.low += m;
    else if (hz < 1500) band.mid += m;
    else if (hz < 5000) band.high += m;
    else band.air += m;
    if (hz < 1500 && m > peak) { peak = m; peakHz = hz; }
  }
  let signalPeak = 0;
  for (let i = 0; i < data.length; i++) signalPeak = Math.max(signalPeak, Math.abs(data[i]));
  let typical = 0;
  const mid = Math.floor(data.length / 2);
  for (let i = 1; i < 4000; i++) typical += Math.abs(data[mid + i] - data[mid + i - 1]);
  return {
    peakHz,
    centroidHz: num / den,
    bandShare: {
      low: band.low / den, mid: band.mid / den,
      high: band.high / den, air: band.air / den,
    },
    peak: signalPeak,
    seamStep: Math.abs(data[0] - data[data.length - 1]),
    typicalStep: typical / 4000,
  };
}

const RPM_POINTS = [3000, 5000, 7000, 9000, 10800, 12000];
const LOADS = ["off", "mid", "on"] as const;

describe("generated engine audio bank", () => {
  it("has an engine loop at every rpm point and load", () => {
    const files = readdirSync(AUDIO_DIR);
    for (const rpm of RPM_POINTS) {
      for (const load of LOADS) {
        expect(files, `missing engine-${rpm}-${load}.wav`).toContain(`engine-${rpm}-${load}.wav`);
      }
    }
    expect(files).toContain("turbo-100.wav");
    expect(files).toContain("bov.wav");
  });

  it("puts the peak at the V6 firing rate, not an octave out", () => {
    for (const rpm of RPM_POINTS) {
      const target = firingHz(rpm);
      for (const load of LOADS) {
        const a = analyse(`engine-${rpm}-${load}.wav`);
        // The generator quantises the cycle to whole samples, which shifts the
        // rate by under 1% (604Hz instead of 600 at redline). Anything
        // beyond that is a pitch bug, not quantisation.
        expect(
          Math.abs(a.peakHz - target) / target,
          `engine-${rpm}-${load}: peak ${a.peakHz}Hz vs firing ${target}Hz`
        ).toBeLessThan(0.02);
      }
    }
  });

  it("brightens with revs and with load, the way an engine does", () => {
    for (const load of LOADS) {
      // The overall trend, not strict monotonicity: off-throttle the spectrum
      // is dominated by the broad combustion noise rather than the (heavily
      // suppressed) tonal harmonics, so the centroid wanders by a percent or
      // two between adjacent rpm points. What must hold is that the top of
      // the range is decisively brighter than the bottom.
      const idle = analyse(`engine-3000-${load}.wav`).centroidHz;
      const redline = analyse(`engine-12000-${load}.wav`).centroidHz;
      expect(
        redline,
        `${load}: redline should be much brighter than idle`
      ).toBeGreaterThan(idle * 1.5);
    }
    for (const rpm of RPM_POINTS) {
      const off = analyse(`engine-${rpm}-off.wav`).centroidHz;
      const on = analyse(`engine-${rpm}-on.wav`).centroidHz;
      expect(on, `engine-${rpm}: on-load should be brighter than off-load`).toBeGreaterThan(off);
    }
  });

  it("is dark and lumpy at idle and bright at redline", () => {
    const idle = analyse("engine-3000-off.wav");
    const redline = analyse("engine-12000-on.wav");
    // At idle most energy belongs in the fundamental; at redline the top end
    // has opened up. A flat profile across the rev range is the "sounds like
    // a synth" failure.
    expect(idle.bandShare.low).toBeGreaterThan(0.4);
    expect(redline.bandShare.mid + redline.bandShare.high + redline.bandShare.air)
      .toBeGreaterThan(idle.bandShare.mid + idle.bandShare.high + idle.bandShare.air);
  });

  it("loops seamlessly", () => {
    // The wrap must be no rougher than the signal's own sample-to-sample
    // motion; a larger step is a click, once per loop.
    for (const name of readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".wav"))) {
      if (name.startsWith("bov") || name.startsWith("crack")) continue; // one-shots
      const a = analyse(name);
      expect(
        a.seamStep,
        `${name}: loop seam ${a.seamStep.toExponential(2)} exceeds typical step ${a.typicalStep.toExponential(2)}`
      ).toBeLessThanOrEqual(a.typicalStep * 2.5);
    }
  });

  it("never clips", () => {
    for (const name of readdirSync(AUDIO_DIR).filter((f) => f.endsWith(".wav"))) {
      const a = analyse(name);
      expect(a.peak, `${name} clips`).toBeLessThanOrEqual(0.9);
    }
  });

  it("puts the turbo in the band people identify as turbo", () => {
    const a = analyse("turbo-100.wav");
    // A turbo scream is thin and high: most of its energy well above the
    // engine's fundamental band.
    expect(a.bandShare.high + a.bandShare.air).toBeGreaterThan(0.5);
    expect(a.centroidHz).toBeGreaterThan(3000);
  });
});
