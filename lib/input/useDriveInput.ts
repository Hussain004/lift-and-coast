import { useEffect, useRef, type RefObject } from "react";
// BRAKE_RAMP_SECONDS is the shared anti-flip brake shaping, documented where
// it is defined. It lives in ./steering rather than here because it is a
// property of the car, not of this input path: the landing page's time attack
// applies the same ramp, and the two must not be able to drift apart.
import { BRAKE_RAMP_SECONDS, stepSteering } from "./steering";
import {
  applyAxisDeadzone,
  engaged,
  findConnectedGamepad,
  gamepadSteerToVehicle,
  readGamepadAxes,
  shapeAnalogAxis,
  splitPedalAxis,
} from "./gamepad";
import type { AeroMode } from "@/lib/physics/aero";
import type { TireCompoundId } from "@/lib/physics/tireModel";
import type { TouchDriveInput } from "./touch";
import {
  applySteerSettings,
  getBindings,
  getControlSettings,
  type ControlAction,
} from "./keyBindings";

export type CameraMode = "chase" | "chase-far" | "cockpit" | "helmet" | "t-cam" | "tv" | "orbit";
/** Every mode except the free orbit, which sits outside the C cycle. */
export type DrivingCameraMode = Exclude<CameraMode, "orbit">;

/** C-key cycle order, the F1 game's: chase near and far, T-cam, cockpit,
 * helmet, then the broadcast cameras. */
export function nextCameraMode(mode: DrivingCameraMode): DrivingCameraMode {
  if (mode === "chase") return "chase-far";
  if (mode === "chase-far") return "t-cam";
  if (mode === "t-cam") return "cockpit";
  if (mode === "cockpit") return "helmet";
  if (mode === "helmet") return "tv";
  return "chase";
}

/** On-screen name for each camera, shown briefly when it is selected. */
export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: "CHASE CAM",
  "chase-far": "FAR CHASE CAM",
  "t-cam": "T-CAM",
  cockpit: "COCKPIT CAM",
  helmet: "HELMET CAM",
  tv: "TV CAM",
  orbit: "ORBIT CAM",
};

/**
 * V-key orbit toggle (plan section 9 replay cam): dropping into orbit
 * remembers the driving mode so V always returns where you came from.
 */
export function toggleOrbitCamera(
  current: CameraMode,
  lastDriving: DrivingCameraMode
): { mode: CameraMode; lastDriving: DrivingCameraMode } {
  if (current === "orbit") return { mode: lastDriving, lastDriving };
  return { mode: "orbit", lastDriving: current };
}

/** C-key: advance the driving cycle, resuming from the stored mode when orbiting. */
export function cycleDrivingCamera(
  current: CameraMode,
  lastDriving: DrivingCameraMode
): CameraMode {
  return nextCameraMode(current === "orbit" ? lastDriving : current);
}

// Explicit selection (one key per compound) rather than a cycle - fitting
// a fresh set of a SPECIFIC compound is always one keystroke, instead of
// needing up to two extra presses to cycle back around to the compound
// you already had (which would otherwise be the only way to reset wear
// without actually wanting to switch compounds).
const TIRE_COMPOUND_KEYS: Record<string, TireCompoundId> = {
  Digit1: "soft",
  Digit2: "medium",
  Digit3: "hard",
  Digit4: "intermediate",
  Digit6: "wet",
};

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  rewind: boolean;
  /**
   * Edge-triggered RELEASE of the rewind key.
   *
   * Separate from `rewind` (held) because the two gestures have to coexist:
   * holding R is still the quick "undo that spin" rewind, and a TAP of R opens
   * the flashback timeline to scrub properly. Only the release edge can tell
   * the two apart, and it is what lets the timeline be added without changing
   * the existing hold behaviour at all.
   */
  rewindReleased: boolean;
  /**
   * Timeline scrub steps, HELD rather than edge-triggered on purpose: the
   * browser's own key repeat then walks the scrub head at a usable speed,
   * which is what makes a 15 second window navigable with two keys instead of
   * requiring 30 separate taps. The head is clamped, so holding a key parks it
   * at whichever end it was pointing at.
   */
  scrubBack: boolean;
  scrubForward: boolean;
  /**
   * Confirm (Enter) and cancel (Escape) for the timeline. Also held, which is
   * safe: confirming closes the timeline and cancelling closes it, so neither
   * can fire twice from one held key.
   */
  confirm: boolean;
  cancel: boolean;
  deploy: boolean;
  /** Hold to request an available 2026 overtake zone. */
  overtake: boolean;
  /** Edge-triggered pit request. */
  pitRequested: boolean;
  /**
   * Edge-triggered pit-stop release (see lib/race/pitRelease.ts). Only means
   * anything inside the green window after a service; consumed and discarded
   * every other frame, exactly like the other one-shot requests.
   */
  pitReleasePressed: boolean;
  /** Edge-triggered instant replay toggle. */
  replayToggle: boolean;
  /** Edge-triggered ERS mode cycle. */
  ersModeCycle: boolean;
  /** Edge-triggered strategy mode cycle. */
  strategyModeCycle: boolean;
  /** Edge-triggered weather preset cycle. */
  weatherCycle: boolean;
  /**
   * Edge-triggered shift requests (manual gear mode only), latched in
   * keydown and consumed exactly once by the update() call that follows -
   * holding the key down does not shift every frame. See update()'s
   * copy/clear/restore below.
   */
  shiftUp: boolean;
  shiftDown: boolean;
  /**
   * Edge-triggered reverse request (5). Only takes effect from a near
   * standstill - see REVERSE_ENGAGE_SPEED_MS in gearbox.ts. Edge-triggered on
   * the same terms as shiftUp/shiftDown: latched on keydown, consumed by
   * exactly one update(), so holding it does not re-request every frame.
   */
  selectReverse: boolean;
}

const STEER_RATE = 5;
const STEER_CENTER_RATE = 7;
/**
 * The keys currently bound to an action.
 *
 * Read through this rather than a module constant, because the table is
 * user-editable at runtime. The keydown handler and update() both resolve
 * through it on every event, so a rebind takes effect on the very next key
 * press with no reload and no stale closure - which is the whole reason the
 * bindings became data instead of constants.
 *
 * A table can never leave an action empty (setBindings refuses one that does),
 * so this always has at least one entry and callers need no fallback.
 */
const boundKeys = (action: ControlAction): readonly string[] => getBindings()[action];

const anyPressed = (keys: Set<string>, codes: readonly string[]) =>
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
 * the Canvas, not a child of it. `touchInputRef` is the matching mutable
 * channel for the adaptive on-screen phone controls.
 */
const EDGE_FLAGS = [
  "shiftUp",
  "shiftDown",
  "selectReverse",
  "pitRequested",
  "pitReleasePressed",
  "replayToggle",
  "ersModeCycle",
  "strategyModeCycle",
  "weatherCycle",
  // The flashback timeline's own edges. Latched here like every other one-shot
  // so they fire exactly once per press even though the timeline is driven
  // from useFrame while the physics step is paused.
  "rewindReleased",
  "scrubBack",
  "scrubForward",
  "confirm",
  "cancel",
] as const;
type EdgeFlag = (typeof EDGE_FLAGS)[number];

export function useDriveInput(
  externalCameraModeRef?: RefObject<CameraMode>,
  externalRacingLineVisibleRef?: RefObject<boolean>,
  touchInputRef?: RefObject<TouchDriveInput | null>
) {
  const keys = useRef(new Set<string>());
  /**
   * A rewind-key release that survives until a consumer acknowledges it.
   * See onKeyUp for why a normal one-tick edge does not work here.
   */
  const stickyRewindReleased = useRef(false);
  const input = useRef<DriveInput>({
    throttle: 0,
    brake: 0,
    steer: 0,
    rewind: false,
    rewindReleased: false,
    scrubBack: false,
    scrubForward: false,
    confirm: false,
    cancel: false,
    deploy: false,
    overtake: false,
    pitRequested: false,
    pitReleasePressed: false,
    replayToggle: false,
    ersModeCycle: false,
    strategyModeCycle: false,
    weatherCycle: false,
    shiftUp: false,
    shiftDown: false,
    selectReverse: false,
  });
  // One-shot requests latched by keydown and drained by update(). Kept apart
  // from `input` on purpose: `input` is also what update() returns, and
  // latching in the same object meant each tick's copy of an edge became the
  // next tick's latched edge, so one press of J toggled instant replay on
  // every physics step forever (same for ERS/strategy/weather/pit keys).
  const pendingEdges = useRef<Record<EdgeFlag, boolean>>({
    shiftUp: false,
    shiftDown: false,
    selectReverse: false,
    pitRequested: false,
    pitReleasePressed: false,
    replayToggle: false,
    ersModeCycle: false,
    strategyModeCycle: false,
    weatherCycle: false,
    rewindReleased: false,
    scrubBack: false,
    scrubForward: false,
    confirm: false,
    cancel: false,
  });
  const aeroMode = useRef<AeroMode>("high-downforce");
  const internalCameraMode = useRef<CameraMode>("chase");
  const cameraMode = externalCameraModeRef ?? internalCameraMode;
  // Driving mode remembered across V-key orbit excursions, so V always
  // returns where you came from and C resumes the cycle there.
  const lastDrivingMode = useRef<DrivingCameraMode>("chase");
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
  // Whether a gamepad/wheel is connected (plan section 5 input shaping) -
  // polled per physics tick, read by the HUD for a visible device indicator.
  const gamepadConnected = useRef(false);
  const internalRacingLineVisible = useRef(true);
  // On by default (plan section 13's "optional ideal-line overlay assist") -
  // same "no Pro difficulty tier yet" reasoning as tractionControlEnabled/
  // absEnabled above.
  const racingLineVisible = externalRacingLineVisibleRef ?? internalRacingLineVisible;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Edge-triggered on the actual first press, not OS key-repeat, since
      // this is a mode toggle (press to switch) rather than a held input.
      if (boundKeys("aeroMode")[0] === e.code && !keys.current.has(e.code)) {
        aeroMode.current =
          aeroMode.current === "high-downforce" ? "low-drag" : "high-downforce";
      }
      if (boundKeys("cameraMode")[0] === e.code && !keys.current.has(e.code)) {
        cameraMode.current = cycleDrivingCamera(cameraMode.current, lastDrivingMode.current);
      }
      if (boundKeys("orbitCamera")[0] === e.code && !keys.current.has(e.code)) {
        const next = toggleOrbitCamera(cameraMode.current, lastDrivingMode.current);
        cameraMode.current = next.mode;
        lastDrivingMode.current = next.lastDriving;
      }
      const selectedCompound = TIRE_COMPOUND_KEYS[e.code];
      if (selectedCompound && !keys.current.has(e.code)) {
        tireCompound.current = selectedCompound;
      }
      if (boundKeys("tractionControl")[0] === e.code && !keys.current.has(e.code)) {
        tractionControlEnabled.current = !tractionControlEnabled.current;
      }
      if (boundKeys("abs")[0] === e.code && !keys.current.has(e.code)) {
        absEnabled.current = !absEnabled.current;
      }
      if (boundKeys("racingLine")[0] === e.code && !keys.current.has(e.code)) {
        racingLineVisible.current = !racingLineVisible.current;
      }
      if (boundKeys("autoGear")[0] === e.code && !keys.current.has(e.code)) {
        autoGear.current = !autoGear.current;
      }
      if (boundKeys("pitRequest")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.pitRequested = true;
      }
      if (boundKeys("pitRelease")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.pitReleasePressed = true;
      }
      if (boundKeys("instantReplay")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.replayToggle = true;
      }
      if (boundKeys("ersMode")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.ersModeCycle = true;
      }
      if (boundKeys("strategyMode")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.strategyModeCycle = true;
      }
      if (boundKeys("weatherCycle")[0] === e.code && !keys.current.has(e.code)) {
        pendingEdges.current.weatherCycle = true;
      }
      // Shift requests latch on the rising edge (no OS key-repeat, same
      // edge detection as the toggles above) and are consumed by the next
      // update() - see the copy/clear/restore in update() below.
      if (boundKeys("shiftUp").includes(e.code) && !keys.current.has(e.code)) {
        pendingEdges.current.shiftUp = true;
      }
      if (boundKeys("shiftDown").includes(e.code) && !keys.current.has(e.code)) {
        pendingEdges.current.shiftDown = true;
      }
      if (boundKeys("reverse").includes(e.code) && !keys.current.has(e.code)) {
        pendingEdges.current.selectReverse = true;
      }
      keys.current.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // Latch the release of the rewind key BEFORE deleting it, so the tap that
      // opens the flashback timeline is a genuine edge. The `keys.current.has`
      // guard is what makes it an edge and not a repeat: without it, a keyup
      // for a code that was never down would fire on every stray event.
      //
      // It goes into `stickyRewindReleased` rather than straight into
      // pendingEdges, and that indirection is load-bearing. pendingEdges is
      // consumed by update(), which Rapier calls once per physics SUBSTEP, and
      // a slow frame runs several substeps before React's useFrame ever runs.
      // A one-tick edge is therefore set and then overwritten back to false
      // within the same frame, and the consumer never sees it - which is
      // exactly how "tap R does nothing" happened. The sticky flag survives
      // until a consumer clears it.
      if (boundKeys("rewind").includes(e.code) && keys.current.has(e.code)) {
        stickyRewindReleased.current = true;
      }
      keys.current.delete(e.code);
    };
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
    gamepadConnected,
    update(dt: number) {
      const pressed = keys.current;
      const touch = touchInputRef?.current;
      const touchSteering = touch?.steeringActive ? touch.steer : null;
      const touchThrottle = touch?.throttle ?? 0;
      const touchBrake = touch?.brake ?? 0;
      // Shift requests are edge-triggered: keydown latches them, this tick
      // consumes them exactly once (copied out before the fields are
      // cleared, so holding Q/Z down can't shift every frame), and they're
      // restored onto the returned input for the tick's consumers
      // (applyCarControls' gearbox handling).
      const edges = { ...pendingEdges.current };
      for (const flag of EDGE_FLAGS) pendingEdges.current[flag] = false;
      const steerTarget =
        (anyPressed(pressed, boundKeys("steerLeft")) ? 1 : 0) -
        (anyPressed(pressed, boundKeys("steerRight")) ? 1 : 0);

      // Gamepad/wheel analog input (plan section 5): polled at 60Hz like
      // the keyboard, merged per-channel. Steering is pure analog (shaped
      // deadzone + response curve, no rate limit - the analog signal IS
      // the smoothing); pedals share the keyboard's brake ramp below
      // because the ramp is the documented anti-pitch instability guard,
      // and analog braking needs the same protection (see BRAKE_RAMP_SECONDS
      // and the comment on the keyboard path two sections up).
      let padSteer: number | null = null;
      let padThrottle: number | null = null;
      let padBrake: number | null = null;
      const pad = findConnectedGamepad();
      gamepadConnected.current = pad !== null;
      if (pad) {
        const raw = readGamepadAxes(pad);
        if (engaged(raw.steer)) padSteer = gamepadSteerToVehicle(raw.steer);
        if (engaged(raw.pedalAxis)) {
          const split = splitPedalAxis(shapeAnalogAxis(raw.pedalAxis));
          padThrottle = Math.max(split.throttleTarget, applyAxisDeadzone(raw.triggerThrottle));
          padBrake = Math.max(split.brakeTarget, applyAxisDeadzone(raw.triggerBrake));
        } else {
          const triggerThrottle = applyAxisDeadzone(raw.triggerThrottle);
          const triggerBrake = applyAxisDeadzone(raw.triggerBrake);
          if (triggerThrottle > 0) padThrottle = triggerThrottle;
          if (triggerBrake > 0) padBrake = triggerBrake;
        }
      }

      // The steer the car will actually see. The raw value - keyboard, analog
      // pad, or the ramped keyboard path - goes through the player's
      // sensitivity settings LAST, so a setting applies uniformly to every
      // input source instead of only the keyboard. Doing it here rather than
      // inside each branch is what makes the setting mean "my steering" and
      // not "my steering on the keyboard".
      const rawSteer =
        touchSteering !== null
          ? touchSteering
          : padSteer !== null
            ? padSteer
            : stepSteering(input.current.steer, steerTarget, dt, STEER_RATE, STEER_CENTER_RATE);
      input.current.steer = applySteerSettings(rawSteer, getControlSettings());

      const keyboardThrottle = anyPressed(pressed, boundKeys("throttle")) ? 1 : 0;
      input.current.throttle = Math.max(keyboardThrottle, padThrottle ?? 0, touchThrottle);

      // Unified brake target from both input sources, ramped with the same
      // guard as the keyboard path: instant release, rate-limited
      // application (and raw full-force application with ABS off - the
      // documented ABS-off tradeoff applies to gamepad braking too).
      const keyboardBrake = anyPressed(pressed, boundKeys("brake")) ? 1 : 0;
      const brakeTarget = Math.max(keyboardBrake, padBrake ?? 0, touchBrake);
      input.current.brake =
        brakeTarget === 0
          ? 0
          : absEnabled.current
            ? Math.min(input.current.brake + dt / BRAKE_RAMP_SECONDS, brakeTarget)
            : brakeTarget;
      input.current.rewind = anyPressed(pressed, boundKeys("rewind"));
      input.current.deploy = anyPressed(pressed, boundKeys("deploy")) || (touch?.deploy ?? false);
      input.current.overtake = anyPressed(pressed, boundKeys("overtake")) || (touch?.overtake ?? false);
      for (const flag of EDGE_FLAGS) input.current[flag] = edges[flag];
      // Read back over the edge loop, which would otherwise have overwritten
      // the sticky release with the always-false pendingEdges value.
      input.current.rewindReleased = stickyRewindReleased.current;
      // The timeline's own keys, read straight off the held key state and
      // assigned AFTER the edge loop for the same reason: they are consumed by
      // useFrame while the physics step is PAUSED, so they cannot depend on a
      // tick that is not running, and they must survive the loop that would
      // otherwise zero them. Held rather than edge-triggered so the browser's
      // own key repeat walks the scrub at a usable speed.
      input.current.scrubBack = anyPressed(pressed, ["ArrowLeft", "BracketLeft"]);
      input.current.scrubForward = anyPressed(pressed, ["ArrowRight", "BracketRight"]);
      input.current.confirm = anyPressed(pressed, ["Enter", "NumpadEnter"]);
      input.current.cancel = anyPressed(pressed, ["Escape"]);
      return input.current;
    },
    /**
     * Acknowledges a rewind-key release. The caller MUST call this once it has
     * acted on it, or the timeline will reopen on every subsequent frame.
     */
    clearRewindReleased() {
      stickyRewindReleased.current = false;
    },
  };
}
