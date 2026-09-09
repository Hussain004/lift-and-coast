import { useEffect, useRef } from "react";
import { stepSteering } from "./steering";

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

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => keys.current.add(e.code);
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
