// Camera comfort preference: shake on or off. Defaults to off when the OS
// asks for reduced motion (plan section 13's accessibility note).

const KEY = "lift-and-coast.camera-shake.v1";
const EVENT = "lift-and-coast:camera";

export function loadCameraShake(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // Fall through to the motion default.
  }
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function saveCameraShake(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeCameraShake(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
