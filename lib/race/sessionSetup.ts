// Plan section 8 (Game Flow & Screens): Session Setup. Quick Race lap
// count, owned here and shared by the home-screen setup panel
// (app/SessionSetup.tsx) and the race page's ?laps= URL param, so both
// clamp identically and the "until session-setup UI exists" comments in
// race/page.tsx and Car.tsx can be retired. The bounds are a correctness
// guard, not a tuning knob - an unbounded value would let a typo (or a
// shared link) produce a 0-lap "race" that finishes on the very first
// crossing, or one so long it's never realistically finished.
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
// opens with the previously picked lap count instead of always resetting
// to the default. Storage is injected rather than read globally so this
// logic is unit-testable without a DOM; the default falls back to a
// guarded global so SSR / privacy modes just get the default prefs.
const SESSION_SETUP_KEY = "lift-and-coast.session-setup.v1";

export interface SessionSetupPrefs {
  raceLaps: number;
}

function clampLaps(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RACE_LAPS;
  return Math.min(MAX_RACE_LAPS, Math.max(MIN_RACE_LAPS, Math.round(n)));
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
  if (!storage) return { raceLaps: DEFAULT_RACE_LAPS };
  try {
    const raw = storage.getItem(SESSION_SETUP_KEY);
    if (!raw) return { raceLaps: DEFAULT_RACE_LAPS };
    const parsed = JSON.parse(raw) as { raceLaps?: unknown };
    return { raceLaps: clampLaps(parsed.raceLaps) };
  } catch {
    return { raceLaps: DEFAULT_RACE_LAPS };
  }
}

export function saveSessionSetupPrefs(
  prefs: SessionSetupPrefs,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  if (!storage) return;
  try {
    storage.setItem(SESSION_SETUP_KEY, JSON.stringify({ raceLaps: clampLaps(prefs.raceLaps) }));
  } catch {
    // Storage full / unavailable - non-fatal, defaults cover the next load.
  }
}