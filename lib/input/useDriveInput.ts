import { useEffect, useRef, type RefObject } from "react";
import { stepSteering } from "./steering";
import type { AeroMode } from "@/lib/physics/aero";
import type { TireCompoundId } from "@/lib/physics/tireModel";

export type CameraMode = "chase" | "cockpit";

// Explicit selection (one key per compound) rather than a cycle - fitting
// a fresh set of a SPECIFIC compound is always one keystroke, instead of
// needing up to two extra presses to cycle back around to the compound
// you already had (which would otherwise be the only way to reset wear
// without actually wanting to switch compounds).
const TIRE_COMPOUND_KEYS: Record<string, TireCompoundId> = {
  Digit1: "soft",
  Digit2: "medium",
  Digit3: "hard",
};

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  rewind: boolean;
  deploy: boolean;
  /**
   * Edge-triggered shift requests (manual gear mode only), latched in
   * keydown and consumed exactly once by the update() call that follows -
   * holding the key down does not shift every frame. See update()'s
   * copy/clear/restore below.
   */
  shiftUp: boolean;
  shiftDown: boolean;
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
//
// This ramp IS what "ABS" means in this project (plan section 5, depth
// feature 5) - toggling absEnabled off removes it, letting brake input
// through instantly and reintroducing the exact real, documented
// instability above. That's the intended tradeoff (real ABS-off driving
// is genuinely harder to control without lockup), not a missing safety
// check.
const BRAKE_RAMP_SECONDS = 0.5;

const THROTTLE_KEYS = ["KeyW", "ArrowUp"];
const BRAKE_KEYS = ["KeyS", "ArrowDown"];
const LEFT_KEYS = ["KeyA", "ArrowLeft"];
const RIGHT_KEYS = ["KeyD", "ArrowRight"];
const REWIND_KEYS = ["KeyR"];
const DEPLOY_KEYS = ["ShiftLeft", "ShiftRight"];
const SHIFT_UP_KEYS = ["KeyQ"];
const SHIFT_DOWN_KEYS = ["KeyZ"];
const AERO_MODE_TOGGLE_KEY = "KeyE";
const CAMERA_MODE_TOGGLE_KEY = "KeyC";
const TRACTION_CONTROL_TOGGLE_KEY = "KeyT";
const ABS_TOGGLE_KEY = "KeyB";
const RACING_LINE_TOGGLE_KEY = "KeyL";
const AUTO_GEAR_TOGGLE_KEY = "KeyG";

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
 *
 * `externalRacingLineVisibleRef` is the same idea, for the same reason -
 * the racing line overlay lives in Track.tsx, a sibling of Car.tsx under
 * the Canvas, not a child of it.
 */
export function useDriveInput(
  externalCameraModeRef?: RefObject<CameraMode>,
  externalRacingLineVisibleRef?: RefObject<boolean>
) {
  const keys = useRef(new Set<string>());
  const input = useRef<DriveInput>({
    throttle: 0,
    brake: 0,
    steer: 0,
    rewind: false,
    deploy: false,
    shiftUp: false,
    shiftDown: false,
  });
  const aeroMode = useRef<AeroMode>("high-downforce");
  const internalCameraMode = useRef<CameraMode>("chase");
  const cameraMode = externalCameraModeRef ?? internalCameraMode;
  const tireCompound = useRef<TireCompoundId>("medium");
  // Both default ON (plan section 5, depth feature 5: "off by default on
  // Pro" - Pro is a difficulty tier that doesn't exist yet, so on is the
  // right default until it does).
  const tractionControlEnabled = useRef(true);
  const absEnabled = useRef(true);
  // Auto-gear assist (plan section 5 depth feature 4: manual gears) - same
  // default-ON reasoning as the other assists: sequential manual shifting is
  // the skill to learn, but until a "Pro" tier exists the shipped default is
  // the assisted gearbox, toggled off with G for real paddles.
  const autoGear = useRef(true);
  const internalRacingLineVisible = useRef(true);
  // On by default (plan section 13's "optional ideal-line overlay assist") -
  // same "no Pro difficulty tier yet" reasoning as tractionControlEnabled/
  // absEnabled above.
  const racingLineVisible = externalRacingLineVisibleRef ?? internalRacingLineVisible;

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
      const selectedCompound = TIRE_COMPOUND_KEYS[e.code];
      if (selectedCompound && !keys.current.has(e.code)) {
        tireCompound.current = selectedCompound;
      }
      if (e.code === TRACTION_CONTROL_TOGGLE_KEY && !keys.current.has(e.code)) {
        tractionControlEnabled.current = !tractionControlEnabled.current;
      }
      if (e.code === ABS_TOGGLE_KEY && !keys.current.has(e.code)) {
        absEnabled.current = !absEnabled.current;
      }
      if (e.code === RACING_LINE_TOGGLE_KEY && !keys.current.has(e.code)) {
        racingLineVisible.current = !racingLineVisible.current;
      }
      if (e.code === AUTO_GEAR_TOGGLE_KEY && !keys.current.has(e.code)) {
        autoGear.current = !autoGear.current;
      }
      // Shift requests latch on the rising edge (no OS key-repeat, same
      // edge detection as the toggles above) and are consumed by the next
      // update() - see the copy/clear/restore in update() below.
      if (SHIFT_UP_KEYS.includes(e.code) && !keys.current.has(e.code)) {
        input.current.shiftUp = true;
      }
      if (SHIFT_DOWN_KEYS.includes(e.code) && !keys.current.has(e.code)) {
        input.current.shiftDown = true;
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
    tireCompound,
    tractionControlEnabled,
    absEnabled,
    racingLineVisible,
    autoGear,
    update(dt: number) {
      const pressed = keys.current;
      // Shift requests are edge-triggered: keydown latches them, this tick
      // consumes them exactly once (copied out before the fields are
      // cleared, so holding Q/Z down can't shift every frame), and they're
      // restored onto the returned input for the tick's consumers
      // (applyCarControls' gearbox handling).
      const shiftUp = input.current.shiftUp;
      const shiftDown = input.current.shiftDown;
      input.current.shiftUp = false;
      input.current.shiftDown = false;
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
        ? absEnabled.current
          ? Math.min(1, input.current.brake + dt / BRAKE_RAMP_SECONDS)
          : 1
        : 0;
      input.current.rewind = anyPressed(pressed, REWIND_KEYS);
      input.current.deploy = anyPressed(pressed, DEPLOY_KEYS);
      input.current.shiftUp = shiftUp;
      input.current.shiftDown = shiftDown;
      return input.current;
    },
  };
}
