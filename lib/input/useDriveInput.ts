import { useEffect, useRef, type RefObject } from "react";
import { stepSteering } from "./steering";
import type { AeroMode } from "@/lib/physics/aero";

export type CameraMode = "chase" | "cockpit";

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  rewind: boolean;
  deploy: boolean;
}

const STEER_RATE = 4;
const STEER_CENTER_RATE = 6;
// Ramp brake input up to full over half a second instead of snapping to 1
// instantly. Found via headless testing at the current (much higher) engine
// force: slamming full brake the instant the key is pressed, after building
// real speed, pitches the chassis violently (tilt exceeded the flip
// threshold above ~0.7 brake amount applied instantly) - the raycast
// suspension has no anti-dive geometry to absorb a full-force step input.
// Ramping the input itself, same technique already used for steering,
// verified safe with a wide margin (~0.3 rad vs the 0.6 flip threshold),
// including combined with hard throttle boost and trail-braking steer.
// Releasing the brake is left instant - only the sudden application caused
// the instability, not the release.
//
// This mitigation lives ONLY in this keyboard input path - it is not a fix
// in the vehicle model itself (lib/physics/vehicle.ts still accepts and
// reacts badly to an instant brake:1). Any other input source that can
// command full brake in one frame - the planned gamepad/wheel analog input
// (implementation_plan.md section 5) or an AI driver braking under braking
// (section 14, "AI harvests battery under braking") - needs the same
// shaping applied at its own point of entry, or a real fix in the vehicle
// model, before it ships.
const BRAKE_RAMP_SECONDS = 0.5;

const THROTTLE_KEYS = ["KeyW", "ArrowUp"];
const BRAKE_KEYS = ["KeyS", "ArrowDown"];
const LEFT_KEYS = ["KeyA", "ArrowLeft"];
const RIGHT_KEYS = ["KeyD", "ArrowRight"];
const REWIND_KEYS = ["KeyR"];
const DEPLOY_KEYS = ["ShiftLeft", "ShiftRight"];
const AERO_MODE_TOGGLE_KEY = "KeyE";
const CAMERA_MODE_TOGGLE_KEY = "KeyC";

const anyPressed = (keys: Set<string>, codes: string[]) =>
  codes.some((code) => keys.has(code));

/**
 * Tracks WASD/arrow key state and exposes a ref with rate-limited steering.
 * Read `.current` inside a render loop (e.g. useFrame) rather than via state,
 * so key changes never trigger a React re-render.
 *
 * `externalCameraModeRef` lets a parent component (Scene.tsx) read the same
 * ref this hook writes to - needed because the camera itself lives outside
 * Car.tsx (a sibling under Canvas, not a child), unlike aeroMode/input,
 * which are only ever read from inside Car.tsx where this hook is called.
 * Falls back to an internally-created ref if omitted (e.g. in tests).
 */
export function useDriveInput(externalCameraModeRef?: RefObject<CameraMode>) {
  const keys = useRef(new Set<string>());
  const input = useRef<DriveInput>({
    throttle: 0,
    brake: 0,
    steer: 0,
    rewind: false,
    deploy: false,
  });
  const aeroMode = useRef<AeroMode>("high-downforce");
  const internalCameraMode = useRef<CameraMode>("chase");
  const cameraMode = externalCameraModeRef ?? internalCameraMode;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Edge-triggered on the actual first press, not OS key-repeat, since
      // this is a mode toggle (press to switch) rather than a held input.
      if (e.code === AERO_MODE_TOGGLE_KEY && !keys.current.has(e.code)) {
        aeroMode.current =
          aeroMode.current === "high-downforce" ? "low-drag" : "high-downforce";
      }
      if (e.code === CAMERA_MODE_TOGGLE_KEY && !keys.current.has(e.code)) {
        cameraMode.current = cameraMode.current === "chase" ? "cockpit" : "chase";
      }
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.current.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // cameraMode is a ref (either the caller's own, stable for the
    // component's lifetime, or the internal one created above) - it's
    // read/written through .current inside the listener, not captured by
    // value, so it doesn't need to be a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    input,
    aeroMode,
    cameraMode,
    update(dt: number) {
      const pressed = keys.current;
      const steerTarget =
        (anyPressed(pressed, LEFT_KEYS) ? 1 : 0) -
        (anyPressed(pressed, RIGHT_KEYS) ? 1 : 0);

      input.current.steer = stepSteering(
        input.current.steer,
        steerTarget,
        dt,
        STEER_RATE,
        STEER_CENTER_RATE
      );
      input.current.throttle = anyPressed(pressed, THROTTLE_KEYS) ? 1 : 0;
      input.current.brake = anyPressed(pressed, BRAKE_KEYS)
        ? Math.min(1, input.current.brake + dt / BRAKE_RAMP_SECONDS)
        : 0;
      input.current.rewind = anyPressed(pressed, REWIND_KEYS);
      input.current.deploy = anyPressed(pressed, DEPLOY_KEYS);
      return input.current;
    },
  };
}
