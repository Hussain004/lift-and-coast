// Plan section 8 (Game Flow & Screens): Session Setup. Quick Race lap
// count and track, owned here and shared by the home-screen setup panel
// (app/SessionSetup.tsx) and the race page's ?laps= / ?track= URL params,
// so both clamp identically. The bounds are a correctness guard, not a
// tuning knob - an unbounded value would let a typo (or a shared link)
// produce a 0-lap "race" that finishes on the very first crossing, or one
// so long it's never realistically finished.
import { useEffect, useState } from "react";
import { DEFAULT_TRACK_ID, isKnownTrackId } from "../tracks/registry";
import {
  DEFAULT_DIFFICULTY,
  type AIDifficulty,
} from "../ai/personalities";

export const MIN_RACE_LAPS = 1;
export const MAX_RACE_LAPS = 20;
export const DEFAULT_RACE_LAPS = 3;

// Plan section 8 (Game Modes): what kind of session a race-page visit is.
// Practice is solo free driving, qualifying sets a grid (see qualifying.ts
// for the formats), race is the wheel-to-wheel event against the AI -
// including championship rounds, which are race sessions with ?champ=.
// Unknown/missing values fall back to race so every existing link
// (which predates the parameter) keeps working unchanged.
export type SessionMode = "practice" | "qualifying" | "race";

export function parseSessionMode(raw: string | null): SessionMode {
  if (raw === "practice" || raw === "qualifying" || raw === "race") return raw;
  return "race";
}

// Qualifying formats (see qualifying.ts): one flying lap after the timer
// starts at the first line crossing, or a 10-minute open session where the
// best valid lap counts. Unknown values fall back to the timed session.
export type QualifyingFormat = "oneshot" | "timed";

export function parseQualifyingFormat(raw: string | null): QualifyingFormat {
  if (raw === "oneshot") return "oneshot";
  return "timed";
}

/** Grid spot for the player from ?grid=, or null (staggered from pole). */
export function parseGridSpot(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 1 && n <= MAX_FIELD_SIZE ? n : null;
}

// Plan section 7 (full field): how many AI rivals share the track - the
// player plus up to 19 rivals fills a 20-car F1 grid. Unknown/missing
// values fall back to the classic duel so every existing link (which
// predates the parameter) keeps working unchanged.
export const MIN_RIVALS = 1;
export const MAX_RIVALS = 19;
export const DEFAULT_RIVALS = 1;
/** Cars on track including the player - the F1 grid size. */
export const MAX_FIELD_SIZE = MAX_RIVALS + 1;

export function parseRivals(raw: string | null): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_RIVALS;
  return Math.min(MAX_RIVALS, Math.max(MIN_RIVALS, n));
}

// AI difficulty (see lib/ai/personalities.ts): unknown/missing values fall
// back to Pro so every existing link keeps today's reference pace.
export function parseDifficulty(raw: string | null): AIDifficulty {
  if (raw === "rookie" || raw === "club" || raw === "ace") return raw;
  return DEFAULT_DIFFICULTY;
}

// Random-grid seed (see the seed field above): a non-negative integer, or
// null when absent/unparseable (legacy pole start, not an error).
export function parseSeed(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export interface RaceUrlParams {
  mode?: SessionMode;
  track?: string;
  laps?: number;
  team?: string;
  driver?: string;
  tod?: TimeOfDay;
  champ?: number | null;
  grid?: number | null;
  qformat?: QualifyingFormat;
  rivals?: number;
  difficulty?: AIDifficulty;
  /**
   * Random-grid seed (?seed=): shuffles the whole grid for quick races
   * (see page.tsx) so the player doesn't always start at pole. Absent on
   * old links (which keep the legacy pole start) and ignored wherever an
   * explicit grid already exists (qualifying results, championship,
   * net rooms).
   */
  seed?: number;
  /**
   * Full grid order (?order=, pole first): set by the qualifying banner
   * so every car lines up where it qualified, not just the player.
   */
  order?: string[];
}

/**
 * Rebuilds a race URL from an existing query string with a new mode/grid -
 * how in-race banners link onward (qualifying -> race from this grid)
 * without dropping the rest of the session (track, laps, roster, champ).
 * Pure over the string so it's unit-testable; callers pass
 * window.location.search.
 */
export function retargetSessionUrl(
  search: string,
  mode: SessionMode,
  grid: number | null,
  order: readonly string[] | null = null
): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  params.set("mode", mode);
  if (grid === null) params.delete("grid");
  else params.set("grid", String(grid));
  if (mode !== "qualifying") params.delete("qformat");
  if (order !== null && order.length > 0) params.set("order", order.join(","));
  else params.delete("order");
  const suffix = params.toString();
  return `/race${suffix ? `?${suffix}` : ""}`;
}

/**
 * Builds race-page URLs in one place so the home screen, the championship
 * panel and the in-race session banners (Car.tsx) can't drift apart -
 * every link carries the full session description explicitly.
 */
export function buildRaceUrl(params: RaceUrlParams): string {
  const query = new URLSearchParams();
  if (params.mode !== undefined) query.set("mode", params.mode);
  if (params.track !== undefined) query.set("track", params.track);
  if (params.laps !== undefined) query.set("laps", String(params.laps));
  if (params.team !== undefined) query.set("team", params.team);
  if (params.driver !== undefined) query.set("driver", params.driver);
  if (params.tod !== undefined) query.set("tod", params.tod);
  if (params.champ !== undefined && params.champ !== null) query.set("champ", String(params.champ));
  if (params.grid !== undefined && params.grid !== null) query.set("grid", String(params.grid));
  if (params.qformat !== undefined) query.set("qformat", params.qformat);
  if (params.rivals !== undefined) query.set("rivals", String(params.rivals));
  if (params.difficulty !== undefined) query.set("diff", params.difficulty);
  if (params.seed !== undefined) query.set("seed", String(params.seed));
  if (params.order !== undefined && params.order.length > 0) {
    query.set("order", params.order.join(","));
  }
  const suffix = query.toString();
  return `/race${suffix ? `?${suffix}` : ""}`;
}

// Plan section 8 (Session Setup): time-of-day lighting preset. Deliberately
// no night: driving it fairly would need headlights and lit track
// furniture, a whole feature - these three all read with the same lighting
// rig, only rebalanced.
export type TimeOfDay = "day" | "sunset" | "overcast";
export const DEFAULT_TIME_OF_DAY: TimeOfDay = "day";

export function parseTimeOfDay(raw: string | null): TimeOfDay {
  return raw === "sunset" || raw === "overcast" ? raw : DEFAULT_TIME_OF_DAY;
}

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
  timeOfDay: TimeOfDay;
  rivals: number;
  difficulty: AIDifficulty;
}

function clampLaps(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RACE_LAPS;
  return Math.min(MAX_RACE_LAPS, Math.max(MIN_RACE_LAPS, Math.round(n)));
}

function clampRivals(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_RIVALS;
  return Math.min(MAX_RIVALS, Math.max(MIN_RIVALS, Math.round(n)));
}

function clampTrackId(raw: unknown): string {
  return typeof raw === "string" && isKnownTrackId(raw) ? raw : DEFAULT_TRACK_ID;
}

function clampTimeOfDay(raw: unknown): TimeOfDay {
  return raw === "sunset" || raw === "overcast" ? raw : DEFAULT_TIME_OF_DAY;
}

function clampDifficulty(raw: unknown): AIDifficulty {
  return raw === "rookie" || raw === "club" || raw === "ace" ? raw : DEFAULT_DIFFICULTY;
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
    timeOfDay: DEFAULT_TIME_OF_DAY,
    rivals: DEFAULT_RIVALS,
    difficulty: DEFAULT_DIFFICULTY,
  };
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(SESSION_SETUP_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as { raceLaps?: unknown; trackId?: unknown; timeOfDay?: unknown; rivals?: unknown; difficulty?: unknown };
    return {
      raceLaps: clampLaps(parsed.raceLaps),
      trackId: clampTrackId(parsed.trackId),
      timeOfDay: clampTimeOfDay(parsed.timeOfDay),
      rivals: clampRivals(parsed.rivals),
      difficulty: clampDifficulty(parsed.difficulty),
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
        timeOfDay: clampTimeOfDay(prefs.timeOfDay),
        rivals: clampRivals(prefs.rivals),
        difficulty: clampDifficulty(prefs.difficulty),
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

/** Live full prefs for panels that read more than the track (session setup
 * owns laps, championship rounds need the light) - same event, whole
 * object, so a preset click refreshes every link on the page. */
export function useSessionSetupPrefs(): SessionSetupPrefs {
  const [prefs, setPrefs] = useState<SessionSetupPrefs>(() => loadSessionSetupPrefs());
  useEffect(() => {
    const refresh = () => setPrefs(loadSessionSetupPrefs());
    window.addEventListener(SESSION_SETUP_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(SESSION_SETUP_CHANGE_EVENT, refresh);
  }, []);
  return prefs;
}