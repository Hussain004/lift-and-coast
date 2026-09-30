import { describe, expect, it } from "vitest";
import { LOD_SWITCH_IN_M, LOD_SWITCH_OUT_M, wantsFarLod } from "../lib/race/carLod";

describe("car level of detail", () => {
  it("goes far past the switch-out distance and near inside the switch-in distance", () => {
    expect(wantsFarLod(false, 10 * 10)).toBe(false);
    expect(wantsFarLod(false, (LOD_SWITCH_OUT_M + 1) ** 2)).toBe(true);
    expect(wantsFarLod(true, (LOD_SWITCH_IN_M - 1) ** 2)).toBe(false);
  });

  it("holds its state between the thresholds so a car on the boundary doesn't flicker", () => {
    const mid = ((LOD_SWITCH_IN_M + LOD_SWITCH_OUT_M) / 2) ** 2;
    expect(wantsFarLod(false, mid)).toBe(false);
    expect(wantsFarLod(true, mid)).toBe(true);
  });
});
