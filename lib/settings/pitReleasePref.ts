// Pit-stop release mini-game on or off. Default ON: it is the driver's half
// of a stop, it can only ever hand back race time (never force - see
// lib/race/pitRelease.ts), and a player who does not want it can turn it off
// in the pause menu without anything else about the stop changing.

const KEY = "lift-and-coast.pit-release.v1";
const EVENT = "lift-and-coast:pit-release";

export function loadPitReleaseEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function savePitReleaseEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribePitReleaseEnabled(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}