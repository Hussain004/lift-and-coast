import { describe, expect, it } from "vitest";
import { flashbackLabel, flashbackLimit } from "../lib/race/flashbacks";

describe("flashback allowance", () => {
  it("shrinks as the opposition gets harder, and only limits races", () => {
    expect(flashbackLimit("rookie", "race")).toBeNull();
    expect(flashbackLimit("club", "race")).toBe(5);
    expect(flashbackLimit("pro", "race")).toBe(3);
    expect(flashbackLimit("ace", "race")).toBe(1);
    expect(flashbackLimit("ace", "practice")).toBeNull();
    expect(flashbackLimit("ace", "qualifying")).toBeNull();
  });

  it("labels what is left", () => {
    expect(flashbackLabel(null)).toBe("UNLIMITED");
    expect(flashbackLabel(2)).toBe("2 LEFT");
  });
});
