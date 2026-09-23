import { describe, expect, it } from "vitest";
import {
  clamp01,
  createRaceAudio,
  defaultCarSnapshot,
  dopplerFactor,
  engineCutoffHz,
  engineFrequencyHz,
  engineGain01,
  impactGain01,
  kerbRumbleHz,
  loadMuted,
  opponentGain01,
  opponentPanLR,
  pickVoicedOpponents,
  rpmTo01,
  saveMuted,
  skidAmount01,
  skidGain01,
  windGain01,
} from "../lib/audio/raceAudio";
import { IDLE_RPM, REDLINE_RPM } from "../lib/physics/gearbox";

describe("race audio mappings", () => {
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
