import { describe, expect, it } from "vitest";
import { DEFAULT_MIXER, levelToGain, parseMixer } from "../lib/settings/mixerPrefs";

describe("mixer prefs", () => {
  it("defaults when nothing or garbage is stored", () => {
    expect(parseMixer(null)).toEqual(DEFAULT_MIXER);
    expect(parseMixer("not json")).toEqual(DEFAULT_MIXER);
    expect(parseMixer("[1,2]")).toEqual(DEFAULT_MIXER);
  });
  it("clamps each channel and ignores unknown keys", () => {
    const m = parseMixer(JSON.stringify({ master: 5, engine: -1, effects: "loud", ui: 0.25, extra: 3 }));
    expect(m).toEqual({ master: 1, engine: 0, effects: 1, engineer: 1, ui: 0.25 });
  });
  it("maps the slider to a squared gain: full is unity, half is a quarter, zero is silent", () => {
    expect(levelToGain(1)).toBe(1);
    expect(levelToGain(0.5)).toBe(0.25);
    expect(levelToGain(0)).toBe(0);
    expect(levelToGain(NaN)).toBe(1);
  });
});
