import { describe, expect, it } from "vitest";
import { DEFAULT_HUD_PREFS, parseHudPrefs } from "../lib/settings/hudPrefs";

describe("HUD prefs", () => {
  it("defaults on missing or broken storage", () => {
    expect(parseHudPrefs(null)).toEqual(DEFAULT_HUD_PREFS);
    expect(parseHudPrefs("{")).toEqual(DEFAULT_HUD_PREFS);
  });
  it("keeps valid fields and repairs the rest", () => {
    const p = parseHudPrefs(JSON.stringify({ scale: "large", panels: { map: false, tower: "no" }, colourBlind: true }));
    expect(p.scale).toBe("large");
    expect(p.panels).toEqual({ tower: true, map: false, mfd: true, engineerText: true });
    expect(p.colourBlind).toBe(true);
    expect(parseHudPrefs(JSON.stringify({ scale: "huge" })).scale).toBe("normal");
  });
});
