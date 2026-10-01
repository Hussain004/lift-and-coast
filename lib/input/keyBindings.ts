/**
 * Control bindings and driving sensitivity, as user-configurable data.
 *
 * This module is the single source of truth for what every key does. It used
 * to be a wall of module-level constants in useDriveInput.ts, which meant the
 * bindings were not configurable at all without editing and rebuilding the
 * input module. They are now data: a table the player can edit, validated
 * here, with a runtime store the input module reads.
 *
 * Two rules the rest of the codebase depends on, both enforced below:
 *
 * 1. Every action keeps at least one key, and a key belongs to at most one
 *    action. A duplicate or an empty binding is a silent way to make the car
 *    undrivable, so both are rejected at the point of change rather than
 *    discovered in a corner.
 * 2. The defaults are exactly the bindings that shipped, so a player who
 *    never opens settings drives identically. `assertDefaultsUnchanged` guards
 *    that in the tests - the whole feature is worthless if touching it moves
 *    the default controls.
 */

/** Every rebindable action. Stable ids - these are persisted, so renaming one
 *  would silently drop a player's binding. */
export const CONTROL_ACTIONS = [
  "throttle",
  "brake",
  "steerLeft",
  "steerRight",
  "shiftUp",
  "shiftDown",
  "reverse",
  "deploy",
  "rewind",
  "cameraMode",
  "orbitCamera",
  "aeroMode",
  "tractionControl",
  "abs",
  "autoGear",
  "racingLine",
  "ersMode",
  "strategyMode",
  "overtake",
  "pitRequest",
  "instantReplay",
  "weatherCycle",
  "lookBack",
  "lookLeft",
  "lookRight",
  "pitRelease",
] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

/** A KeyboardEvent.code value, e.g. "KeyW", "ArrowUp", "Digit5". */
export type KeyCode = string;

/** Bindings for every action, each a list so a key can have alternates. */
export type ControlBindings = Record<ControlAction, readonly KeyCode[]>;

/**
 * The shipped bindings, verbatim. These are what a player has today, and
 * what they keep if they never touch settings.
 */
export const DEFAULT_BINDINGS: ControlBindings = {
  throttle: ["KeyW", "ArrowUp"],
  brake: ["KeyS", "ArrowDown"],
  steerLeft: ["KeyA", "ArrowLeft"],
  steerRight: ["KeyD", "ArrowRight"],
  shiftUp: ["KeyQ"],
  shiftDown: ["KeyZ"],
  reverse: ["Digit5"],
  deploy: ["ShiftLeft", "ShiftRight"],
  rewind: ["KeyR"],
  cameraMode: ["KeyC"],
  orbitCamera: ["KeyV"],
  aeroMode: ["KeyE"],
  tractionControl: ["KeyT"],
  abs: ["KeyB"],
  autoGear: ["KeyG"],
  racingLine: ["KeyL"],
  ersMode: ["KeyI"],
  strategyMode: ["KeyY"],
  overtake: ["KeyX"],
  pitRequest: ["KeyO"],
  instantReplay: ["KeyJ"],
  weatherCycle: ["KeyU"],
  lookBack: ["Backquote"],
  lookLeft: ["BracketLeft"],
  lookRight: ["BracketRight"],
  // 7, not a letter: all 26 letters are already bound (see the fixed keys in
  // the pause menu), 0 is telemetry and 1-4/6 are the compounds, with 5
  // reverse. Space is the only other free key, and it activates buttons in
  // the pause menu and MFD, so it would fire a stop-release while the player
  // was trying to click something.
  pitRelease: ["Digit7"],
};

/** Human labels for the settings UI. */
export const CONTROL_LABELS: Record<ControlAction, string> = {
  throttle: "Throttle",
  brake: "Brake",
  steerLeft: "Steer left",
  steerRight: "Steer right",
  shiftUp: "Shift up",
  shiftDown: "Shift down",
  reverse: "Reverse",
  deploy: "Deploy ERS",
  rewind: "Rewind",
  cameraMode: "Camera",
  orbitCamera: "Orbit camera",
  aeroMode: "Aero mode",
  tractionControl: "Traction control",
  abs: "ABS",
  autoGear: "Auto gearbox",
  racingLine: "Racing line",
  ersMode: "ERS mode",
  strategyMode: "Strategy mode",
  overtake: "Overtake",
  pitRequest: "Pit request",
  instantReplay: "Instant replay",
  weatherCycle: "Weather cycle",
  lookBack: "Look back (hold)",
  lookLeft: "Look left (hold)",
  lookRight: "Look right (hold)",
  pitRelease: "Pit release",
};

/** Driving sensitivity and assist defaults the player can set. */
export interface ControlSettings {
  /**
   * Steering input multiplier, 0.5-2. Applied to the analog/derived steer
   * value before it reaches the vehicle, so it scales the whole response
   * including gamepad input. 1 is as shipped.
   */
  steerSensitivity: number;
  /**
   * Fraction of full lock to ignore at the centre, 0-0.3. Raises the smallest
   * steer the car will actually take, which is what stops a resting stick or a
   * worn keyboard from wandering.
   */
  steerDeadzone: number;
  /** Default tyre compound for a new session: "soft" | "medium" | "hard". */
  defaultCompound: "soft" | "medium" | "hard";
  /** Assist defaults for a new session. */
  tractionControlDefault: boolean;
  absDefault: boolean;
  /** Invert the steering axis, for a wheel or a left-handed setup. */
  invertSteering: boolean;
}

export const DEFAULT_SETTINGS: ControlSettings = {
  steerSensitivity: 1,
  steerDeadzone: 0,
  defaultCompound: "medium",
  tractionControlDefault: true,
  absDefault: true,
  invertSteering: false,
};

/** Bounds, so a hand-edited or corrupted value cannot produce an undrivable
 *  car. The sensitivity ceiling is 2x, not more: past that the steering is
 *  twitchy enough to be dangerous rather than quick. */
export const STEER_SENSITIVITY_MIN = 0.5;
export const STEER_SENSITIVITY_MAX = 2;
export const STEER_DEADZONE_MAX = 0.3;

/** What a rejected change looks like, so the UI can explain itself. */
export type ControlProblem =
  | { kind: "empty"; action: ControlAction }
  | { kind: "duplicate"; action: ControlAction; key: KeyCode; owner: ControlAction };

/**
 * Validates a whole binding table. Returns every problem rather than the
 * first, so the settings UI can mark all the offending rows at once.
 *
 * Checks: no action left empty, and no key claimed by two actions. Unknown
 * actions and non-string keys are ignored here - `normalizeBindings` deals
 * with those.
 */
export function validateBindings(bindings: ControlBindings): ControlProblem[] {
  const problems: ControlProblem[] = [];
  const owner = new Map<string, ControlAction>();
  for (const action of CONTROL_ACTIONS) {
    const keys = bindings[action] ?? [];
    if (keys.length === 0) {
      problems.push({ kind: "empty", action });
      continue;
    }
    for (const key of keys) {
      const normalized = key.toLowerCase();
      const existing = owner.get(normalized);
      if (existing !== undefined) {
        problems.push({ kind: "duplicate", action, key, owner: existing });
      } else {
        owner.set(normalized, action);
      }
    }
  }
  return problems;
}

/** True when the table has no problems at all. */
export function bindingsAreValid(bindings: ControlBindings): boolean {
  return validateBindings(bindings).length === 0;
}

/**
 * Repairs a stored table into something safe to drive with: unknown actions
 * dropped, non-string keys dropped, blanks removed, and any key claimed twice
 * given to its FIRST claimant - which is the shipped default owner in every
 * realistic case, so a corrupt file degrades to the defaults rather than to
 * something surprising.
 */
export function normalizeBindings(input: unknown): ControlBindings {
  const out = {} as Record<ControlAction, KeyCode[]>;
  for (const action of CONTROL_ACTIONS) out[action] = [];
  if (typeof input !== "object" || input === null) {
    for (const action of CONTROL_ACTIONS) out[action] = [...DEFAULT_BINDINGS[action]];
    return out;
  }
  const claimed = new Set<string>();
  const record = input as Record<string, unknown>;
  // Defaults first, so a partial stored object still yields every action.
  for (const action of CONTROL_ACTIONS) {
    const raw = record[action];
    if (!Array.isArray(raw)) continue;
    for (const key of raw) {
      if (typeof key !== "string" || key.length === 0) continue;
      const normalized = key.toLowerCase();
      if (claimed.has(normalized)) continue;
      claimed.add(normalized);
      out[action].push(key);
    }
  }
  for (const action of CONTROL_ACTIONS) {
    // Anything left empty falls back to its default, so no action can become
    // unreachable - the one failure mode that would strand a player.
    if (out[action].length === 0) out[action] = [...DEFAULT_BINDINGS[action]];
  }
  return out;
}

/** Clamps every sensitivity field into range and drops unknown keys. */
export function normalizeSettings(input: unknown): ControlSettings {
  if (typeof input !== "object" || input === null) return { ...DEFAULT_SETTINGS };
  const raw = input as Record<string, unknown>;
  const clamp = (value: unknown, min: number, max: number, fallback: number) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  return {
    steerSensitivity: clamp(
      raw.steerSensitivity,
      STEER_SENSITIVITY_MIN,
      STEER_SENSITIVITY_MAX,
      DEFAULT_SETTINGS.steerSensitivity
    ),
    steerDeadzone: clamp(raw.steerDeadzone, 0, STEER_DEADZONE_MAX, DEFAULT_SETTINGS.steerDeadzone),
    defaultCompound:
      raw.defaultCompound === "soft" || raw.defaultCompound === "hard"
        ? raw.defaultCompound
        : DEFAULT_SETTINGS.defaultCompound,
    tractionControlDefault:
      typeof raw.tractionControlDefault === "boolean"
        ? raw.tractionControlDefault
        : DEFAULT_SETTINGS.tractionControlDefault,
    absDefault:
      typeof raw.absDefault === "boolean" ? raw.absDefault : DEFAULT_SETTINGS.absDefault,
    invertSteering:
      typeof raw.invertSteering === "boolean" ? raw.invertSteering : DEFAULT_SETTINGS.invertSteering,
  };
}

/**
 * Applies the sensitivity settings to a raw steer value in -1..1, returning
 * the value the vehicle will actually see.
 *
 * The deadzone is a SCALE, not a threshold: the steer value is re-centred on
 * the deadzone and stretched so the full lock is still reachable, so raising
 * the deadzone removes twitch without costing range. That is the difference
 * between a deadzone and a scale limit, and it is why this is not simply
 * `if (Math.abs(v) < dz) return 0`.
 */
export function applySteerSettings(rawSteer: number, settings: ControlSettings): number {
  if (!Number.isFinite(rawSteer)) return 0;
  let steer = Math.min(1, Math.max(-1, rawSteer));
  if (settings.invertSteering) steer = -steer;
  const dz = settings.steerDeadzone;
  if (dz > 0) {
    const magnitude = Math.abs(steer);
    if (magnitude <= dz) return 0;
    steer = Math.sign(steer) * ((magnitude - dz) / (1 - dz));
  }
  return Math.min(1, Math.max(-1, steer * settings.steerSensitivity));
}

/**
 * The runtime binding table the input module reads. A module-level mutable
 * value rather than React state, because the keydown handler needs the current
 * table synchronously and re-rendering on every rebind would be both wasteful
 * and wrong (a keydown arriving mid-render must not see a stale table).
 */
let activeBindings: ControlBindings = DEFAULT_BINDINGS;
let activeSettings: ControlSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

/** The bindings currently in force. Never null, always at least one key per
 *  action, so the input module can index it without guarding. */
export function getBindings(): ControlBindings {
  return activeBindings;
}

export function getControlSettings(): ControlSettings {
  return activeSettings;
}

/** Notifies subscribers that the table changed, for the settings UI. */
export function subscribeToControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Installs a binding table. A table with problems is REJECTED and the current
 * one kept, because a half-applied rebind - one action emptied, or a key
 * stolen from another action - would silently change the controls under the
 * player mid-corner. Returns whether it was accepted.
 */
export function setBindings(next: ControlBindings): boolean {
  if (!bindingsAreValid(next)) return false;
  activeBindings = next;
  for (const listener of listeners) listener();
  return true;
}

/** Installs sensitivity settings, normalized into range first. */
export function setControlSettings(next: ControlSettings): void {
  activeSettings = normalizeSettings(next);
  for (const listener of listeners) listener();
}

/** Back to the shipped defaults, for a "reset" button. */
export function resetControls(): void {
  activeBindings = DEFAULT_BINDINGS;
  activeSettings = DEFAULT_SETTINGS;
  for (const listener of listeners) listener();
}

/** Pretty-prints a key code for the settings UI: "KeyW" -> "W". */
export function formatKeyCode(code: KeyCode): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code === "ShiftLeft") return "L Shift";
  if (code === "ShiftRight") return "R Shift";
  if (code === "ControlLeft") return "L Ctrl";
  if (code === "ControlRight") return "R Ctrl";
  if (code === "AltLeft") return "L Alt";
  if (code === "AltRight") return "R Alt";
  if (code === "Space") return "Space";
  if (code.startsWith("Arrow")) return code.slice(5);
  return code;
}
