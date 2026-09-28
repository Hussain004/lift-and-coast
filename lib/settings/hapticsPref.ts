// Controller rumble / phone vibration on or off (on by default).

const KEY = "lift-and-coast.haptics.v1";
const EVENT = "lift-and-coast:haptics";

export function loadHaptics(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function saveHaptics(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeHaptics(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Rumble strengths for a frame: kerbs buzz the light motor, slides the heavy
 * one a little, an impact slams both. Pure, so the mapping is testable.
 */
export function rumbleFor(kerb01: number, skid01: number, impact01: number): { weak: number; strong: number } {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    weak: clamp(Math.max(kerb01 * 0.55, skid01 > 0.4 ? skid01 * 0.35 : 0, impact01)),
    strong: clamp(Math.max(kerb01 * 0.18, skid01 > 0.6 ? skid01 * 0.25 : 0, impact01)),
  };
}
