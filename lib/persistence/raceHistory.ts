import { RACE_HISTORY_STORE, idbDelete, idbGetAll, idbPut, openDB } from "./db";
import { MAX_RACE_HISTORY, capHistory, isRaceHistoryRecord, type RaceHistoryRecord } from "../race/raceHistory";

/** Appends a finished race, then drops the oldest records past the cap. */
export async function appendRaceRecord(record: RaceHistoryRecord): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  const key = `${record.at}#${Math.random().toString(36).slice(2, 8)}`;
  await idbPut(db, RACE_HISTORY_STORE, key, record);
  const all = await idbGetAll<unknown>(db, RACE_HISTORY_STORE);
  const keys = Object.keys(all);
  if (keys.length > MAX_RACE_HISTORY) {
    // Keys start with the ISO timestamp, so lexical order is chronological.
    for (const old of keys.sort().slice(0, keys.length - MAX_RACE_HISTORY)) {
      await idbDelete(db, RACE_HISTORY_STORE, old);
    }
  }
}

/** Every stored race, newest first. Corrupt records are skipped, never thrown on. */
export async function loadRaceHistory(): Promise<RaceHistoryRecord[]> {
  if (typeof indexedDB === "undefined") return [];
  const db = await openDB();
  const all = await idbGetAll<unknown>(db, RACE_HISTORY_STORE);
  return capHistory(Object.values(all).filter(isRaceHistoryRecord));
}

/** Restores records from a save bundle (a restore adds to what is already there). */
export async function importRaceRecords(records: readonly RaceHistoryRecord[]): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  for (const record of records) {
    await idbPut(db, RACE_HISTORY_STORE, `${record.at}#${record.driverCode}${record.trackId}`, record);
  }
}
