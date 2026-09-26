import { describe, expect, it } from "vitest";
import {
  AUDIO_RPM_POINTS,
  clamp01,
  createRaceAudio,
  crossfadeWeights,
  defaultCarSnapshot,
  dopplerFactor,
  engineCutoffHz,
  engineFrequencyHz,
  engineGain01,
  impactGain01,
  kerbRumbleHz,
  limiterAmount,
  loadMuted,
  mguFrequencyHz,
  mguGain01,
  opponentGain01,
  opponentPanLR,
  pickVoicedOpponents,
  rpmBracket,
  rpmTo01,
  saveMuted,
  smoothRpm01,
  skidAmount01,
  skidGain01,
  turboGain01,
  turboLagCoefficient,
  windGain01,
} from "../lib/audio/raceAudio";
import { IDLE_RPM, REDLINE_RPM, REV_LIMITER_RPM } from "../lib/physics/gearbox";

describe("race audio mappings", () => {
  it("starts every audio source with explicit limiter and shift telemetry", () => {
    const car = defaultCarSnapshot();
    expect(car.limiter01).toBe(0);
    expect(car.shiftSerial).toBe(0);
  });
  it("stays silent without a browser audio stack", () => {
    expect(createRaceAudio()).toBeNull();
  });

  it("maps the rpm band 0-1 onto a rising snarl", () => {
    expect(rpmTo01(IDLE_RPM)).toBe(0);
    expect(rpmTo01(REDLINE_RPM)).toBe(1);
    expect(rpmTo01(IDLE_RPM - 5000)).toBe(0);
    expect(rpmTo01(REDLINE_RPM + 5000)).toBe(1);
    expect(engineFrequencyHz(1)).toBeGreaterThan(engineFrequencyHz(0));
    expect(engineFrequencyHz(0.5)).toBeGreaterThan(60);
  });

  it("keeps limiter load smooth and the fundamental on the V6 firing rate", () => {
    expect(limiterAmount(REDLINE_RPM)).toBe(0);
    expect(limiterAmount(REV_LIMITER_RPM)).toBe(1);
    expect(limiterAmount(REV_LIMITER_RPM + 5000)).toBe(1);
    expect(limiterAmount(REDLINE_RPM + 400)).toBeGreaterThan(0);
    // A four-stroke V6 fires three times per crank revolution, so the
    // fundamental is rpm/60 x 3: 150Hz at this sim's 3000rpm idle and 600Hz
    // at its 12000rpm redline. This used to be rpm/60 x 1.5 (an octave low)
    // and was then capped at 320Hz, which flattened the top of the rev range
    // entirely - two separate reasons the engine never sounded like an F1.
    expect(engineFrequencyHz(0)).toBeCloseTo(IDLE_RPM / 20, 6);
    expect(engineFrequencyHz(1)).toBeCloseTo(REDLINE_RPM / 20, 6);
    expect(engineFrequencyHz(1)).toBeGreaterThan(500);
  });

  it("brackets the bank by rpm and crossfades equal-power", () => {
    expect(rpmBracket(0)).toEqual({ lo: 0, hi: 0, t: 0 });
    expect(rpmBracket(1)).toEqual({ lo: 5, hi: 5, t: 0 });
    const mid = rpmBracket(0.5);
    expect(AUDIO_RPM_POINTS[mid.lo]).toBeLessThanOrEqual(IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * 0.5);
    expect(AUDIO_RPM_POINTS[mid.hi]).toBeGreaterThanOrEqual(IDLE_RPM + (REDLINE_RPM - IDLE_RPM) * 0.5);
    // Equal power: the sum of squares is flat, so a crossfade does not dip in
    // the middle the way a linear one does.
    const [a, b] = crossfadeWeights(0.37);
    expect(a * a + b * b).toBeCloseTo(1, 9);
    expect(a).toBeGreaterThan(b);
  });

  it("lags the turbo spooling up less than it dumps it", () => {
    // Wastegate dumps boost far faster than the turbine recovers it, so the
    // lag coefficient must be larger on the way down.
    expect(turboLagCoefficient(false)).toBeGreaterThan(turboLagCoefficient(true));
    expect(turboGain01(0, 1)).toBe(0);
    expect(turboGain01(1, 1)).toBeGreaterThan(0);
  });

  it("drives the MGU-K whine only from real deployment", () => {
    expect(mguGain01(0)).toBe(0);
    expect(mguGain01(1)).toBeGreaterThan(0);
    expect(mguFrequencyHz(1)).toBeGreaterThan(mguFrequencyHz(0));
  });

  it("smooths rpm toward a new target without overshooting", () => {
    expect(smoothRpm01(0, 1, 0.18)).toBeCloseTo(0.18, 9);
    expect(smoothRpm01(1, 0, 0.18)).toBeCloseTo(0.82, 9);
    let value = 0;
    for (let i = 0; i < 80; i++) value = smoothRpm01(value, 1);
    expect(value).toBeCloseTo(1, 2);
    expect(smoothRpm01(0.5, 2, 0.5)).toBe(0.75);
  });
  it("opens the filter with throttle and keeps an idle bed", () => {
    expect(engineGain01(0)).toBeGreaterThan(0);
    expect(engineGain01(1)).toBeGreaterThan(engineGain01(0));
    expect(engineCutoffHz(0.5, 1)).toBeGreaterThan(engineCutoffHz(0.5, 0));
  });

  it("keeps the screech silent in normal driving", () => {
    // Parked, straight-line, and ordinary cornering lateral velocities.
    expect(skidAmount01(0, 0)).toBe(0);
    expect(skidAmount01(0, 70)).toBe(0);
    expect(skidAmount01(1.5, 40)).toBe(0);
    expect(skidAmount01(10, 5)).toBe(0);
    // A real slide speaks, scaling to full lock-slide.
    expect(skidAmount01(5, 40)).toBeGreaterThan(0);
    expect(skidAmount01(8, 40)).toBe(1);
    expect(skidGain01(1)).toBeGreaterThan(engineGain01(1));
  });

  it("fades and pans the opponent engine by relative position", () => {
    expect(opponentGain01(0)).toBeCloseTo(0.1);
    expect(opponentGain01(30)).toBeCloseTo(0.05);
    expect(opponentGain01(1000)).toBeLessThan(0.01);
    // Facing -Z at yaw 0 (see lib/tracks/minimap.ts): +X is to the right.
    expect(opponentPanLR(10, 0, 0)).toBe(1);
    expect(opponentPanLR(-10, 0, 0)).toBe(-1);
    expect(opponentPanLR(0, -10, 0)).toBe(0);
    expect(opponentPanLR(0, 0, 0)).toBe(0);
  });

  it("pitches rivals up approaching and down receding", () => {
    expect(dopplerFactor(0)).toBe(1);
    expect(dopplerFactor(-30)).toBeGreaterThan(1);
    expect(dopplerFactor(30)).toBeLessThan(1);
    // Bounded even for absurd closing speeds.
    expect(dopplerFactor(-10000)).toBeLessThan(2.5);
  });

  it("voices the nearest rivals, and holds a voice through a near tie", () => {
    const at = (x: number) => ({ ...defaultCarSnapshot(), x });
    const player = { x: 0, z: 0 };
    const field = [at(50), at(10), null, at(30), at(20), at(500)];
    expect(pickVoicedOpponents(player, field, [], 3)).toEqual([1, 4, 3]);
    // Car 0 is voiced and only a little further than car 3: it keeps it.
    expect(pickVoicedOpponents(player, [at(40), at(10), at(20), at(35)], [0, 1, 2], 3)).toEqual([1, 2, 0]);
    // Out of earshot is silent.
    expect(pickVoicedOpponents(player, [at(400)], [], 3)).toEqual([]);
  });

  it("rises wind with speed and keeps the kerb rumble in the thump band", () => {
    expect(windGain01(0)).toBe(0);
    expect(windGain01(40)).toBeLessThan(windGain01(80));
    expect(windGain01(200)).toBeCloseTo(windGain01(85), 9);
    expect(kerbRumbleHz(0)).toBeGreaterThanOrEqual(14);
    expect(kerbRumbleHz(40)).toBeGreaterThan(kerbRumbleHz(20));
    expect(kerbRumbleHz(90)).toBeLessThanOrEqual(95);
  });

  it("gates impacts from wheel taps to chassis hits", () => {
    expect(impactGain01(0)).toBe(0);
    expect(impactGain01(3000)).toBe(0);
    expect(impactGain01(15000)).toBeGreaterThan(0);
    expect(impactGain01(100000)).toBe(1);
  });

  it("clamps", () => {
    expect(clamp01(-2)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });
});

describe("mute pref", () => {
  it("round-trips through storage and defaults to live", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    expect(loadMuted(storage)).toBe(false);
    saveMuted(true, storage);
    expect(loadMuted(storage)).toBe(true);
    saveMuted(false, storage);
    expect(loadMuted(storage)).toBe(false);
    expect(loadMuted(null)).toBe(false);
    expect(() => saveMuted(true, null)).not.toThrow();
  });
});
