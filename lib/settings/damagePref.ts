// How much a crash costs: Off, Reduced (half the damage, no punctures) or
// Simulation (full component damage and punctures). Read once per session
// start, so it is a pure localStorage value with no live subscription need
// beyond the settings screen itself.
import { isDamageMode, type DamageMode } from "../physics/damage";

const KEY = "lift-and-coast.damage-mode.v1";
const EVENT = "lift-and-coast:damage-mode";
export const DEFAULT_DAMAGE_MODE: DamageMode = "reduced";

export function loadDamageMode(): DamageMode {
  if (typeof window === "undefined") return DEFAULT_DAMAGE_MODE;
  try {
    const raw = window.localStorage.getItem(KEY);
    return isDamageMode(raw) ? raw : DEFAULT_DAMAGE_MODE;
  } catch {
    return DEFAULT_DAMAGE_MODE;
  }
}

export function saveDamageMode(mode: DamageMode): void {
  try {
    window.localStorage.setItem(KEY, mode);
  } catch {
    // Non-fatal.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeDamageMode(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
