/**
 * Control settings persistence. LOCAL FIRST, ACCOUNT SYNC OPTIONAL.
 *
 * A player who never signs in gets working, saved settings immediately, in
 * localStorage, with no account and no network. Signing in is additive: it
 * adds a copy in the database and pulls that copy down on the next visit. It
 * is never required, so there is no login wall in front of the game and
 * nothing breaks if Supabase is unreachable.
 *
 * This is the same contract the leaderboard uses, for the same reason: the
 * game must not be able to fail because a server did. Every function here is
 * total - storage that throws, a network that times out and a signed-out
 * player all resolve to "use what you have".
 */

import {
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  getBindings,
  getControlSettings,
  normalizeBindings,
  normalizeSettings,
  resetControls,
  setBindings,
  setControlSettings,
  type ControlBindings,
  type ControlSettings,
} from "../input/keyBindings";

const STORAGE_KEY = "lift-and-coast.controls.v1";

export interface StoredControls {
  bindings: ControlBindings;
  settings: ControlSettings;
}

/** The page's localStorage, or null where it is unavailable. Guarded, because
 *  a browser with storage disabled throws on access rather than returning
 *  null, and that must not take the race page down with it. */
export function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Reads the local copy, or null when there is none or it is unreadable. */
export function loadLocalControls(
  storage: Pick<Storage, "getItem"> | null
): StoredControls | null {
  if (storage === null) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    return {
      bindings: normalizeBindings(record.bindings),
      settings: normalizeSettings(record.settings),
    };
  } catch {
    // Corrupt JSON is not worth an error: fall back to the defaults, which is
    // exactly the state a first-time player is in anyway.
    return null;
  }
}

/** Writes the local copy. Returns whether it stuck. */
export function saveLocalControls(
  storage: Pick<Storage, "setItem"> | null,
  controls: StoredControls
): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(controls));
    return true;
  } catch {
    // Private browsing, a full quota, or storage disabled. The settings still
    // apply for this session; they just will not outlive it.
    return false;
  }
}

/** The controls currently in force, as a persistable object. */
export function currentControls(): StoredControls {
  return { bindings: getBindings(), settings: getControlSettings() };
}

/** Applies a stored object to the live control tables. */
export function applyControls(controls: StoredControls): void {
  setBindings(controls.bindings);
  setControlSettings(controls.settings);
}

/** Reverts to the shipped defaults in memory. */
export function applyDefaultControls(): void {
  resetControls();
}

/** Convenience for a fresh install. */
export function defaultControls(): StoredControls {
  return {
    bindings: { ...DEFAULT_BINDINGS },
    settings: { ...DEFAULT_SETTINGS },
  };
}

/**
 * What the settings UI reports back to the player, so a failure is never
 * silent: did the local write work, is an account signed in, did the sync go
 * up or come down.
 */
export interface ControlsSaveReport {
  savedLocally: boolean;
  synced: boolean;
  /** True when the account copy was pulled and differs from what is in force. */
  pulledFromAccount: boolean;
}
