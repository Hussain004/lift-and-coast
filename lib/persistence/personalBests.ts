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

function getAllRecords(db: IDBDatabase): Promise<Record<string, PersonalBestRecord>> {
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    let keys: IDBValidKey[] | null = null;
    let values: PersonalBestRecord[] | null = null;
    const maybeResolve = () => {
      if (keys === null || values === null) return;
      const result: Record<string, PersonalBestRecord> = {};
      keys.forEach((key, i) => {
        result[String(key)] = values![i];
      });
      resolve(result);
    };
    keysRequest.onsuccess = () => {
      keys = keysRequest.result;
      maybeResolve();
    };
    valuesRequest.onsuccess = () => {
      values = valuesRequest.result;
      maybeResolve();
    };
    keysRequest.onerror = () => reject(keysRequest.error);
    valuesRequest.onerror = () => reject(valuesRequest.error);
  });
}

export interface SaveBundle {
  schemaVersion: 1;
  exportedAt: string;
  personalBests: Record<string, PersonalBestRecord>;
}

/**
 * Plan section 10: "Export/import: a 'dump my save' button (JSON file) and
 * re-import - backup and device transfer without a backend." Bundles every
 * track's personal best (including ghost data - the whole point of a
 * backup is not losing your hot lap, not just the number) into one JSON
 * object; the caller (the export button) turns this into a downloadable
 * file.
 */
export async function exportSaveData(): Promise<SaveBundle> {
  if (typeof indexedDB === "undefined") {
    return { schemaVersion: 1, exportedAt: new Date().toISOString(), personalBests: {} };
  }
  const db = await openDB();
  const personalBests = await getAllRecords(db);
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), personalBests };
}

/**
 * Restores a bundle from exportSaveData - used for both device transfer and
 * a local backup restore. Overwrites any existing record for the same
 * trackId (a restore is expected to replace, not merge, matching what a
 * user asking to "re-import my save" wants). Throws on malformed input so
 * the caller (the import button) can show a real error instead of silently
 * doing nothing.
 */
export async function importSaveData(bundle: unknown): Promise<void> {
  if (
    typeof bundle !== "object" ||
    bundle === null ||
    !("personalBests" in bundle) ||
    typeof (bundle as { personalBests: unknown }).personalBests !== "object" ||
    (bundle as { personalBests: unknown }).personalBests === null
  ) {
    throw new Error("Not a valid Lift & Coast save file.");
  }
  const personalBests = (bundle as { personalBests: Record<string, unknown> }).personalBests;
  for (const [trackId, record] of Object.entries(personalBests)) {
    if (!isPersonalBestRecord(record)) {
      throw new Error(`Not a valid Lift & Coast save file: bad record for "${trackId}".`);
    }
  }
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  for (const [trackId, record] of Object.entries(personalBests as Record<string, PersonalBestRecord>)) {
    await putRecord(db, trackId, record);
  }
}

function isPersonalBestRecord(value: unknown): value is PersonalBestRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PersonalBestRecord).bestLapSeconds === "number" &&
    Array.isArray((value as PersonalBestRecord).ghost)
  );
}
