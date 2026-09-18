// Plan section 8 (Game Flow & Screens): Session Setup. Quick Race lap
// count and track, owned here and shared by the home-screen setup panel
// (app/SessionSetup.tsx) and the race page's ?laps= / ?track= URL params,
// so both clamp identically. The bounds are a correctness guard, not a
// tuning knob - an unbounded value would let a typo (or a shared link)
// produce a 0-lap "race" that finishes on the very first crossing, or one
// so long it's never realistically finished.
import { useEffect, useState } from "react";
import { DEFAULT_TRACK_ID, isKnownTrackId } from "../tracks/registry";

export const MIN_RACE_LAPS = 1;
export const MAX_RACE_LAPS = 20;
export const DEFAULT_RACE_LAPS = 3;

export function parseRaceLaps(raw: string | null): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_RACE_LAPS;
  return Math.min(MAX_RACE_LAPS, Math.max(MIN_RACE_LAPS, n));
}

// localStorage-backed "last selections" (plan section 10: localStorage is
// for settings/state like this, IndexedDB for save data): the session
// opens with the previously picked lap count and track instead of always
// resetting to the defaults. Storage is injected rather than read globally
// so this logic is unit-testable without a DOM; the default falls back to
// a guarded global so SSR / privacy modes just get the default prefs.
const SESSION_SETUP_KEY = "lift-and-coast.session-setup.v1";

export interface SessionSetupPrefs {
  raceLaps: number;
  trackId: string;
}

function clampLaps(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RACE_LAPS;
  return Math.min(MAX_RACE_LAPS, Math.max(MIN_RACE_LAPS, Math.round(n)));
}

function clampTrackId(raw: unknown): string {
  return typeof raw === "string" && isKnownTrackId(raw) ? raw : DEFAULT_TRACK_ID;
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Privacy modes can throw on access - treat as no storage.
    return null;
  }
}

export function loadSessionSetupPrefs(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): SessionSetupPrefs {
  const defaults: SessionSetupPrefs = {
    raceLaps: DEFAULT_RACE_LAPS,
    trackId: DEFAULT_TRACK_ID,
  };
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(SESSION_SETUP_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as { raceLaps?: unknown; trackId?: unknown };
    return {
      raceLaps: clampLaps(parsed.raceLaps),
      trackId: clampTrackId(parsed.trackId),
    };
  } catch {
    return defaults;
  }
}

export function saveSessionSetupPrefs(
  prefs: SessionSetupPrefs,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(
      SESSION_SETUP_KEY,
      JSON.stringify({
        raceLaps: clampLaps(prefs.raceLaps),
        trackId: clampTrackId(prefs.trackId),
      })
    );
  } catch {
    // Storage full / unavailable - non-fatal, defaults cover the next load.
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_SETUP_CHANGE_EVENT));
  }
}

/** Fired on window whenever saveSessionSetupPrefs persists, so every setup
 * panel on the page (world-map pins, Drive link) re-reads the same track
 * without prop drilling - same pattern as lib/race/roster.ts. */
export const SESSION_SETUP_CHANGE_EVENT = "lift-and-coast:session-setup-change";

/** Live track pick for setup panels: re-reads whenever any panel persists,
 * so the world map highlight and the Drive link always agree. */
export function useSessionTrackId(): string {
  const [trackId, setTrackId] = useState<string>(() => loadSessionSetupPrefs().trackId);
  useEffect(() => {
    const refresh = () => setTrackId(loadSessionSetupPrefs().trackId);
    window.addEventListener(SESSION_SETUP_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SESSION_SETUP_CHANGE_EVENT, refresh);
  }, []);
  return trackId;
}