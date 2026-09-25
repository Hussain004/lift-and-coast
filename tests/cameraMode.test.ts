import { describe, expect, it } from "vitest";
import { cycleDrivingCamera, nextCameraMode, toggleOrbitCamera } from "../lib/input/useDriveInput";

describe("nextCameraMode", () => {
  it("cycles chase -> cockpit -> helmet -> t-cam -> tv -> chase", () => {
    expect(nextCameraMode("chase")).toBe("cockpit");
    expect(nextCameraMode("cockpit")).toBe("helmet");
    expect(nextCameraMode("helmet")).toBe("t-cam");
    expect(nextCameraMode("t-cam")).toBe("tv");
    expect(nextCameraMode("tv")).toBe("chase");
  });
});

describe("orbit camera switching", () => {
  it("toggles between orbit and the stored driving mode", () => {
    expect(toggleOrbitCamera("helmet", "chase")).toEqual({ mode: "orbit", lastDriving: "helmet" });
    expect(toggleOrbitCamera("orbit", "helmet")).toEqual({ mode: "helmet", lastDriving: "helmet" });
  });

  it("resumes the driving cycle from the stored mode", () => {
    expect(cycleDrivingCamera("cockpit", "chase")).toBe("helmet");
    expect(cycleDrivingCamera("orbit", "helmet")).toBe("t-cam");
    expect(cycleDrivingCamera("orbit", "tv")).toBe("chase");
  });
});
