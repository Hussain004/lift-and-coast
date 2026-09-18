import { describe, expect, it } from "vitest";
import { cycleDrivingCamera, nextCameraMode, toggleOrbitCamera } from "../lib/input/useDriveInput";

describe("nextCameraMode", () => {
  it("cycles chase -> cockpit -> t-cam -> tv -> chase", () => {
    expect(nextCameraMode("chase")).toBe("cockpit");
    expect(nextCameraMode("cockpit")).toBe("t-cam");
    expect(nextCameraMode("t-cam")).toBe("tv");
    expect(nextCameraMode("tv")).toBe("chase");
  });
});

describe("orbit camera switching", () => {
  it("toggles between orbit and the stored driving mode", () => {
    expect(toggleOrbitCamera("cockpit", "chase")).toEqual({ mode: "orbit", lastDriving: "cockpit" });
    expect(toggleOrbitCamera("orbit", "cockpit")).toEqual({ mode: "cockpit", lastDriving: "cockpit" });
  });

  it("resumes the driving cycle from the stored mode", () => {
    expect(cycleDrivingCamera("cockpit", "chase")).toBe("t-cam");
    expect(cycleDrivingCamera("orbit", "cockpit")).toBe("t-cam");
    expect(cycleDrivingCamera("orbit", "tv")).toBe("chase");
  });
});
