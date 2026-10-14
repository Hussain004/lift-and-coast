import { describe, expect, it } from "vitest";
import { clampPhoto, createPhotoState, photoFilename, photoFilterCss, PHOTO_FILTERS, PHOTO_FOV_MAX, PHOTO_FOV_MIN, PHOTO_ROLL_MAX } from "../lib/race/photo";

describe("photo mode", () => {
  it("keeps the fov and roll in range", () => {
    const s = createPhotoState();
    s.fovDeg = 400;
    s.rollDeg = -90;
    clampPhoto(s);
    expect(s.fovDeg).toBe(PHOTO_FOV_MAX);
    expect(s.rollDeg).toBe(-PHOTO_ROLL_MAX);
    s.fovDeg = 1;
    expect(clampPhoto(s).fovDeg).toBe(PHOTO_FOV_MIN);
  });

  it("makes a safe, sortable file name", () => {
    expect(photoFilename("Autodromo Nazionale Monza", new Date(2026, 8, 29, 14, 30, 5))).toBe(
      "lift-and-coast-autodromo-nazionale-monza-20260929-143005.png"
    );
    expect(photoFilename("###", new Date(2026, 0, 2, 3, 4, 5))).toBe("lift-and-coast-race-20260102-030405.png");
  });
});

describe("photo filters", () => {
  it("starts natural, which is no filter at all", () => {
    expect(createPhotoState().filter).toBe("natural");
    expect(photoFilterCss("natural")).toBe("none");
  });
  it("has a distinct CSS grade for every other filter", () => {
    const css = PHOTO_FILTERS.filter((f) => f.id !== "natural").map((f) => f.css);
    expect(new Set(css).size).toBe(css.length);
    expect(photoFilterCss("mono")).toContain("grayscale(1)");
  });
});
