import { useEffect, useRef } from "react";
import { stepSteering } from "./steering";
import type { AeroMode } from "@/lib/physics/aero";

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  rewind: boolean;
  deploy: boolean;
}

const STEER_RATE = 4;
const STEER_CENTER_RATE = 6;

const THROTTLE_KEYS = ["KeyW", "ArrowUp"];
const BRAKE_KEYS = ["KeyS", "ArrowDown"];
const LEFT_KEYS = ["KeyA", "ArrowLeft"];
const RIGHT_KEYS = ["KeyD", "ArrowRight"];
const REWIND_KEYS = ["KeyR"];
const DEPLOY_KEYS = ["ShiftLeft", "ShiftRight"];
const AERO_MODE_TOGGLE_KEY = "KeyE";

const anyPressed = (keys: Set<string>, codes: string[]) =>
  codes.some((code) => keys.has(code));

/**
 * Tracks WASD/arrow key state and exposes a ref with rate-limited steering.
 * Read `.current` inside a render loop (e.g. useFrame) rather than via state,
 * so key changes never trigger a React re-render.
 */
export function useDriveInput() {
  const keys = useRef(new Set<string>());
  const input = useRef<DriveInput>({
    throttle: 0,
    brake: 0,
    steer: 0,
    rewind: false,
    deploy: false,
  });
  const aeroMode = useRef<AeroMode>("high-downforce");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Edge-triggered on the actual first press, not OS key-repeat, since
      // this is a mode toggle (press to switch) rather than a held input.
      if (e.code === AERO_MODE_TOGGLE_KEY && !keys.current.has(e.code)) {
        aeroMode.current =
          aeroMode.current === "high-downforce" ? "low-drag" : "high-downforce";
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
  }, []);

  return {
    input,
    aeroMode,
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
      input.current.brake = anyPressed(pressed, BRAKE_KEYS) ? 1 : 0;
      input.current.rewind = anyPressed(pressed, REWIND_KEYS);
      input.current.deploy = anyPressed(pressed, DEPLOY_KEYS);
      return input.current;
    },
  };
}
