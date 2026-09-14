import type { GhostSample } from "../race/ghostRecorder";

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

const DB_NAME = "lift-and-coast";
const DB_VERSION = 1;
const STORE_NAME = "personalBests";
const CURRENT_SCHEMA_VERSION = 1;

function legacyBestLapKey(trackId: string) {
  return `lift-and-coast:best-lap:${trackId}`;
}

// Cached rather than re-opened per call (matches ensureRapierInit's shape
// in lib/ai/harness.ts) - an IDBDatabase connection left open across many
// small get/put calls is the normal pattern, and re-opening per call would
// leave every past connection dangling open anyway (IndexedDB has no
// automatic close), which would later block a schema upgrade's
// onupgradeneeded from ever firing (it waits for every open connection to
// close first).
let dbPromise: Promise<IDBDatabase> | null = null;
function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function getRecord(db: IDBDatabase, trackId: string): Promise<PersonalBestRecord | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(trackId);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function putRecord(db: IDBDatabase, trackId: string, record: PersonalBestRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, trackId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
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
  const existing = await getRecord(db, trackId);
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
  await putRecord(db, trackId, migrated);
  return migrated;
}

export async function savePersonalBest(trackId: string, record: PersonalBestRecord): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  await putRecord(db, trackId, record);
}
