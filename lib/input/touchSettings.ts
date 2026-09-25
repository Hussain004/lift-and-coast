export type TouchStickSize = "small" | "medium" | "large";

export const TOUCH_STICK_SIZE_OPTIONS: readonly TouchStickSize[] = ["small", "medium", "large"];
export const DEFAULT_TOUCH_STICK_SIZE: TouchStickSize = "medium";

const TOUCH_STICK_SIZE_KEY = "lift-and-coast.touch-stick-size.v1";

export function parseTouchStickSize(raw: string | null): TouchStickSize {
  return raw === "small" || raw === "medium" || raw === "large"
    ? raw
    : DEFAULT_TOUCH_STICK_SIZE;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadTouchStickSize(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): TouchStickSize {
  if (!storage) return DEFAULT_TOUCH_STICK_SIZE;
  try {
    return parseTouchStickSize(storage.getItem(TOUCH_STICK_SIZE_KEY));
  } catch {
    return DEFAULT_TOUCH_STICK_SIZE;
  }
}

export function saveTouchStickSize(
  size: TouchStickSize,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(TOUCH_STICK_SIZE_KEY, size);
  } catch {
    // Privacy mode or a full storage quota should not break driving.
  }
}
