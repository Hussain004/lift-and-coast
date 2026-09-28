// How the race engineer speaks: out loud (browser speech), as on-screen
// radio text only, or not at all. A plain localStorage preference, read
// through subscribe/get so React can use it as an external store.

export type EngineerMode = "voice" | "text" | "off";

export const ENGINEER_MODES: { id: EngineerMode; label: string }[] = [
  { id: "voice", label: "Voice + text" },
  { id: "text", label: "Text only" },
  { id: "off", label: "Off" },
];

const KEY = "lift-and-coast.engineer.v1";
const EVENT = "lift-and-coast:engineer";

export function parseEngineerMode(raw: string | null | undefined): EngineerMode {
  return raw === "voice" || raw === "off" ? raw : "text";
}

export function loadEngineerMode(): EngineerMode {
  if (typeof window === "undefined") return "text";
  try {
    return parseEngineerMode(window.localStorage.getItem(KEY));
  } catch {
    return "text";
  }
}

export function saveEngineerMode(mode: EngineerMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // Non-fatal: the default applies next visit.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeEngineerMode(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
