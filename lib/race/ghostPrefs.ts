// Persistence for which ghost you race (roadmap 11.9).
//
// Separate from sessionSetup.ts on purpose: the ghost choice is a Time Trial
// concern, it changes far less often than a setup slider, and it has its own
// vocabulary (a choice id, not a number in a band). Folding it into the setup
// prefs would mean every car-setup change rewrote a key the ghost picker owns.
//
// Storage is injected and every read is clamped, following the same pattern as
// sessionSetup.ts and roster.ts, so the logic is unit-testable without a DOM
// and a corrupted value degrades to "no selection" instead of throwing.

import { ghostChoiceStorageValue, type GhostCandidate, type GhostChoiceId } from "./ghostSelection";

export const GHOST_CHOICE_KEY = "lift-and-coast.ghost-choice.v1";

/** Fired on window whenever the choice changes, so every picker re-reads it. */
export const GHOST_CHOICE_EVENT = "lift-and-coast:ghost-choice";

const CHOICE_IDS: GhostChoiceId[] = ["personal-best", "rival", "world-record"];

/**
 * removeItem is in the injected surface because "no ghost selected" has to be
 * a real cleared state, not an empty string that a future read would have to
 * special-case.
 */
export type GhostChoiceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): GhostChoiceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Privacy modes can throw on access - treat as no storage.
    return null;
  }
}

/**
 * The stored choice, or null for none.
 *
 * Returns null rather than a default id: the correct default depends on
 * whether the player has a personal best at all, which is not known here. The
 * resolution to something raceable happens in resolveGhostChoice, which does
 * have that context.
 */
export function loadGhostChoice(storage: GhostChoiceStorage | null = defaultStorage()): GhostChoiceId | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GHOST_CHOICE_KEY);
    if (!raw) return null;
    // An unrecognised value - a choice removed in a later version, or junk -
    // is treated as no choice rather than trusted.
    return CHOICE_IDS.includes(raw as GhostChoiceId) ? (raw as GhostChoiceId) : null;
  } catch {
    return null;
  }
}

/**
 * Persists the choice, or clears it.
 *
 * Only an AVAILABLE choice is written, and that is enforced here rather than
 * at the call site because the failure it prevents is invisible: an
 * unavailable id in storage resolves to a silent fallback on the next load, so
 * the player would pick "Rival", see it not apply, and have no way to tell
 * whether the app or the storage had lost it.
 */
export function saveGhostChoice(
  choice: GhostCandidate | null,
  storage: GhostChoiceStorage | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    const value = ghostChoiceStorageValue(choice);
    if (value === null) storage.removeItem(GHOST_CHOICE_KEY);
    else storage.setItem(GHOST_CHOICE_KEY, value);
  } catch {
    // A full or unavailable quota is not worth failing a click over.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(GHOST_CHOICE_EVENT));
  }
}
