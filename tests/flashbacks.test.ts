import { describe, expect, it } from "vitest";
import { flashbackLabel, flashbackLimit } from "../lib/race/flashbacks";

describe("flashback allowance", () => {
  it("is unlimited at every AI level and in every session", () => {
    for (const level of ["rookie", "club", "pro", "ace"] as const) {
      for (const mode of ["race", "practice", "qualifying"]) expect(flashbackLimit(level, mode)).toBeNull();
    }
  });

  it("labels what is left", () => {
    expect(flashbackLabel(null)).toBe("UNLIMITED");
    expect(flashbackLabel(2)).toBe("2 LEFT");
  });
});
