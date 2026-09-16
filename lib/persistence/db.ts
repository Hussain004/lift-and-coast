// Plan section 10 (persistence without a database): one IndexedDB database
// holds every persisted store. Kept in its own module so each store's own
// file (personalBests.ts, championship.ts) owns only its data shape and
// queries, and so a schema upgrade in one place creates every store
// consistently.
export const PERSONAL_BESTS_STORE = "personalBests";
export const CHAMPIONSHIP_STORE = "championship";

const DB_NAME = "lift-and-coast";
// v1 = personalBests only. v2 adds the championship store; the upgrade
// handler below creates only the stores that are missing, so an existing
// v1 player's personal bests/ghosts survive the bump untouched.
const DB_VERSION = 2;

// Cached rather than re-opened per call - an IDBDatabase connection left
// open across many small get/put calls is the normal pattern, and
// re-opening per call would leave every past connection dangling open
// anyway (IndexedDB has no automatic close), which would later block a
// schema upgrade's onupgradeneeded from ever firing (it waits for every
// open connection to close first).
let dbPromise: Promise<IDBDatabase> | null = null;
export function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PERSONAL_BESTS_STORE)) {
          db.createObjectStore(PERSONAL_BESTS_STORE);
        }
        if (!db.objectStoreNames.contains(CHAMPIONSHIP_STORE)) {
          db.createObjectStore(CHAMPIONSHIP_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

export function idbGet<T>(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, "readonly").objectStore(store).get(key);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
}

export function idbPut(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey,
  value: unknown
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function idbDelete(
  db: IDBDatabase,
  store: string,
  key: IDBValidKey
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function idbGetAll<T>(db: IDBDatabase, store: string): Promise<Record<string, T>> {
  return new Promise((resolve, reject) => {
    const objectStore = db.transaction(store, "readonly").objectStore(store);
    const keysRequest = objectStore.getAllKeys();
    const valuesRequest = objectStore.getAll();
    let keys: IDBValidKey[] | null = null;
    let values: T[] | null = null;
    const maybeResolve = () => {
      if (keys === null || values === null) return;
      const result: Record<string, T> = {};
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
