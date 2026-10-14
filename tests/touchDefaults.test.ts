import { describe, expect, it } from "vitest";
import { markTouchDefaultsApplied, shouldApplyTouchDefaults } from "../lib/settings/touchDefaults";

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe("touch defaults", () => {
  it("applies on the first touch only", () => {
    const s = memory();
    expect(shouldApplyTouchDefaults("touch", s)).toBe(true);
    markTouchDefaultsApplied(s);
    expect(shouldApplyTouchDefaults("touch", s)).toBe(false);
  });
  it("ignores mouse and pen input, and unavailable storage", () => {
    expect(shouldApplyTouchDefaults("mouse", memory())).toBe(false);
    expect(shouldApplyTouchDefaults("pen", memory())).toBe(false);
    expect(shouldApplyTouchDefaults("touch", null)).toBe(false);
  });
});
