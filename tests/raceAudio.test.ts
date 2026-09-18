import { describe, expect, it } from "vitest";
import {
  clamp01,
  createRaceAudio,
  engineCutoffHz,
  engineFrequencyHz,
  engineGain01,
  impactGain01,
  loadMuted,
  opponentGain01,
  opponentPanLR,
  rpmTo01,
  saveMuted,
  skidAmount01,
  skidGain01,
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
