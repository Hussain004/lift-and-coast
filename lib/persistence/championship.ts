// Plan section 10: "IndexedDB: ... race results, championship state." One
// season is a single record under a fixed key ("current") - there is only
// ever one active season, and keeping it as one record means an update is a
// single put rather than a per-round store.
import {
  CHAMPIONSHIP_STORE,
  idbDelete,
  idbGet,
  idbPut,
  openDB,
} from "./db";
import {
  isChampionshipSeason,
  recordQualiResult,
  recordRoundResult,
  type ChampionshipSeason,
} from "../race/championship";

const CURRENT_SEASON_KEY = "current";

/**
 * Loads the active season, or null if none has been started (or IndexedDB is
 * unavailable, or the stored record fails the shape guard - a corrupt record
 * must not crash the home screen; the player can just start a new season).
 */
export async function loadSeason(): Promise<ChampionshipSeason | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDB();
  const record = await idbGet<unknown>(db, CHAMPIONSHIP_STORE, CURRENT_SEASON_KEY);
  return isChampionshipSeason(record) ? record : null;
}

export async function saveSeason(season: ChampionshipSeason): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  await idbPut(db, CHAMPIONSHIP_STORE, CURRENT_SEASON_KEY, season);
}

export async function clearSeason(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  await idbDelete(db, CHAMPIONSHIP_STORE, CURRENT_SEASON_KEY);
}

/**
 * Qualifying writer: loads the active season, records the player's grid
 * spot for `roundIndex`, and saves. Same no-op discipline as
 * recordChampionshipResult (no season, or out-of-range round, does
 * nothing) since this also runs fire-and-forget from the race loop.
 */
export async function recordChampionshipQuali(
  roundIndex: number,
  qualiSpot: 1 | 2
): Promise<ChampionshipSeason | null> {
  const season = await loadSeason();
  if (!season) return null;
  const updated = recordQualiResult(season, roundIndex, qualiSpot);
  if (updated === season) return season;
  await saveSeason(updated);
  return updated;
}

/**
 * Race-finish writer: loads the active season, records the player's finishing
 * position for `roundIndex`, and saves. Returns the updated season, or null if
 * there is no active season (e.g. a `?champ=` link opened after the season was
 * cleared) - a no-op rather than an error, since this runs fire-and-forget
 * from the race loop. Out-of-range round indices are ignored by
 * recordRoundResult.
 */
export async function recordChampionshipResult(
  roundIndex: number,
  playerPosition: number
): Promise<ChampionshipSeason | null> {
  const season = await loadSeason();
  if (!season) return null;
  const updated = recordRoundResult(season, roundIndex, playerPosition);
  if (updated === season) return season;
  await saveSeason(updated);
  return updated;
}
