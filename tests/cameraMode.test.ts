import { describe, expect, it } from "vitest";
import { nextCameraMode } from "../lib/input/useDriveInput";

describe("nextCameraMode", () => {
  it("cycles chase -> cockpit -> t-cam -> chase", () => {
    expect(nextCameraMode("chase")).toBe("cockpit");
    expect(nextCameraMode("cockpit")).toBe("t-cam");
    expect(nextCameraMode("t-cam")).toBe("chase");
  });
});
