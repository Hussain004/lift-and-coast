import { describe, expect, it } from "vitest";
import { EXISTING_PREF_KEYS, markTouchDefaultsApplied, shouldApplyTouchDefaults } from "../lib/settings/touchDefaults";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("touch defaults", () => {
  it("applies on the first touch of a fresh phone only", () => {
    const s = memory();
    expect(shouldApplyTouchDefaults("touch", s, true)).toBe(true);
    markTouchDefaultsApplied(s);
    expect(shouldApplyTouchDefaults("touch", s, true)).toBe(false);
  });
  it("ignores mouse and pen input, and unavailable storage", () => {
    expect(shouldApplyTouchDefaults("mouse", memory(), true)).toBe(false);
    expect(shouldApplyTouchDefaults("pen", memory(), true)).toBe(false);
    expect(shouldApplyTouchDefaults("touch", null, true)).toBe(false);
  });
  it("never touches a touchscreen laptop (the primary pointer is a mouse)", () => {
    expect(shouldApplyTouchDefaults("touch", memory(), false)).toBe(false);
  });
  it("never overwrites a returning player's settings, whichever one they have", () => {
    for (const key of EXISTING_PREF_KEYS) {
      const s = memory();
      s.setItem(key, "anything");
      expect(shouldApplyTouchDefaults("touch", s, true)).toBe(false);
    }
  });
});
