// How often the safety car comes out: Off, Rare or Frequent. Read once when a
// race starts, so it is a plain localStorage value with a subscription only
// for the settings screen.
import { DEFAULT_SAFETY_CAR_SETTING, isSafetyCarSetting, type SafetyCarSetting } from "../race/safetyCar";

const KEY = "lift-and-coast.safety-car.v1";
const EVENT = "lift-and-coast:safety-car";

export function loadSafetyCarSetting(): SafetyCarSetting {
  if (typeof window === "undefined") return DEFAULT_SAFETY_CAR_SETTING;
  try {
    const raw = window.localStorage.getItem(KEY);
    return isSafetyCarSetting(raw) ? raw : DEFAULT_SAFETY_CAR_SETTING;
  } catch {
    return DEFAULT_SAFETY_CAR_SETTING;
  }
}

export function saveSafetyCarSetting(setting: SafetyCarSetting): void {
  try {
    window.localStorage.setItem(KEY, setting);
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeSafetyCarSetting(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
