// Racing line style: the full line, or only where you need to lift or
// brake (the F1 game's "corners only"). The L key still shows/hides it.

export type RacingLineStyle = "full" | "corners";

const KEY = "lift-and-coast.racing-line-style.v1";
const EVENT = "lift-and-coast:racing-line-style";

export function loadRacingLineStyle(): RacingLineStyle {
  if (typeof window === "undefined") return "full";
  try {
    return window.localStorage.getItem(KEY) === "corners" ? "corners" : "full";
  } catch {
    return "full";
  }
}

export function saveRacingLineStyle(style: RacingLineStyle): void {
  try {
    window.localStorage.setItem(KEY, style);
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeRacingLineStyle(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
