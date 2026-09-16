import {
  CHAMPIONSHIP_STORE,
  PERSONAL_BESTS_STORE,
  idbGet,
  idbGetAll,
  idbPut,
  openDB,
} from "./db";
import {
  isChampionshipSeason,
  type ChampionshipSeason,
} from "../race/championship";
import type { PersonalBestRecord } from "./personalBests";

// v1 = personalBests only. v2 adds the optional championship season; import
// still accepts v1 bundles (championship simply absent) so an older export
// keeps restoring cleanly.
const CURRENT_SCHEMA_VERSION = 2;
const CHAMPIONSHIP_KEY = "current";

export interface SaveBundle {
  schemaVersion: 2;
  exportedAt: string;
  personalBests: Record<string, PersonalBestRecord>;
  championship: ChampionshipSeason | null;
}

/**
 * Plan section 10: "Export/import: a 'dump my save' button (JSON file) and
 * re-import - backup and device transfer without a backend." Bundles every
 * track's personal best (including ghost data - the whole point of a
 * backup is not losing your hot lap, not just the number) plus the active
 * championship season into one JSON object; the caller (the export button)
 * turns this into a downloadable file.
 */
export async function exportSaveData(): Promise<SaveBundle> {
  if (typeof indexedDB === "undefined") {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      personalBests: {},
      championship: null,
    };
  }
  const db = await openDB();
  const personalBests = await idbGetAll<PersonalBestRecord>(db, PERSONAL_BESTS_STORE);
  const stored = await idbGet<unknown>(db, CHAMPIONSHIP_STORE, CHAMPIONSHIP_KEY);
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    personalBests,
    championship: isChampionshipSeason(stored) ? stored : null,
  };
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
  // Optional: v1 bundles have no championship field at all.
  const championship = (bundle as { championship?: unknown }).championship;
  if (championship !== undefined && championship !== null && !isChampionshipSeason(championship)) {
    throw new Error("Not a valid Lift & Coast save file: bad championship season.");
  }
  if (typeof indexedDB === "undefined") return;
  const db = await openDB();
  for (const [trackId, record] of Object.entries(personalBests as Record<string, PersonalBestRecord>)) {
    await idbPut(db, PERSONAL_BESTS_STORE, trackId, record);
  }
  if (isChampionshipSeason(championship)) {
    await idbPut(db, CHAMPIONSHIP_STORE, CHAMPIONSHIP_KEY, championship);
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
