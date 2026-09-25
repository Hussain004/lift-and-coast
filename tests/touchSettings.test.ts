import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOUCH_STICK_SIZE,
  loadTouchStickSize,
  parseTouchStickSize,
  saveTouchStickSize,
} from "../lib/input/touchSettings";

describe("touch stick size settings", () => {
  it("parses known sizes and falls back safely", () => {
    expect(parseTouchStickSize("small")).toBe("small");
    expect(parseTouchStickSize("medium")).toBe("medium");
    expect(parseTouchStickSize("large")).toBe("large");
    expect(parseTouchStickSize("huge")).toBe(DEFAULT_TOUCH_STICK_SIZE);
    expect(parseTouchStickSize(null)).toBe(DEFAULT_TOUCH_STICK_SIZE);
  });

  it("round-trips through injected storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    expect(loadTouchStickSize(storage)).toBe(DEFAULT_TOUCH_STICK_SIZE);
    saveTouchStickSize("large", storage);
    expect(loadTouchStickSize(storage)).toBe("large");
  });
});
