import type { GhostSample } from "../race/ghostRecorder";
import { PERSONAL_BESTS_STORE, idbGet, idbPut, openDB } from "./db";

/**
 * Personal-best storage (plan section 10: "IndexedDB: personal bests, ghost
 * replay data ... too big for localStorage"). Replaces the earlier
 * localStorage-only float (see loadLegacyBestLapSeconds below) now that the
 * ghost replay feature needs a full lap's worth of per-tick samples
 * alongside the time - too much to reasonably store as a single string.
 */
export interface PersonalBestRecord {
  schemaVersion: 1;
  bestLapSeconds: number;
  ghost: GhostSample[];
}

const CURRENT_SCHEMA_VERSION = 1;

function legacyBestLapKey(trackId: string) {
  return `lift-and-coast:best-lap:${trackId}`;
}

/**
 * Loads the saved personal best for a track. If no IndexedDB record exists
 * yet, migrates the old localStorage-only lap time (from before ghost
 * replay existed) into a fresh record with no ghost data - the next new
 * best lap fills that in normally. Returns null if there's nothing saved
 * either way, or if IndexedDB/localStorage aren't available (SSR, or a
 * browser context that blocks them).
 */
export async function loadPersonalBest(trackId: string): Promise<PersonalBestRecord | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await openDB();
  const existing = await idbGet<PersonalBestRecord>(db, PERSONAL_BESTS_STORE, trackId);
  if (existing) return existing;

  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(legacyBestLapKey(trackId));
  const legacySeconds = raw === null ? null : Number(raw);
  if (legacySeconds === null || !Number.isFinite(legacySeconds)) return null;

  const migrated: PersonalBestRecord = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    bestLapSeconds: legacySeconds,
    ghost: [],
  };
  await idbPut(db, PERSONAL_BESTS_STORE, trackId, migrated);
  return migrated;
}

export async function savePersonalBest(trackId: string, record: PersonalBestRecord): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  await idbPut(db, PERSONAL_BESTS_STORE, trackId, record);
}
