/**
 * Lap-time leaderboard: the data shape, the validation, and the identity.
 *
 * PURE on purpose. The network call lives in leaderboardClient.ts and the UI
 * in app/race, so everything that can be wrong about a submission - the time
 * bounds, the ordering, the tie-break, the per-browser id - is unit-tested
 * here without a network or a DOM.
 *
 * The board is a nice-to-have, never a dependency. Every function here is
 * total: it returns a value or null, never throws, and the caller is expected
 * to carry on when it gets null. A leaderboard outage must cost the player
 * their record, not their race.
 */

/** A row on the public board. Mirrors the table in supabase/migrations. */
export interface LeaderboardEntry {
  trackId: string;
  lapMs: number;
  driverCode: string;
  teamId: string;
  compound: string;
  /** When the lap was submitted, ISO-8601 from the server. */
  createdAt: string;
}

export interface LapSubmission {
  trackId: string;
  lapMs: number;
  driverCode: string;
  teamId: string;
  compound: string;
}

/** Tyre compounds the board accepts; mirrors the table's CHECK constraint. */
export const LEADERBOARD_COMPOUNDS: ReadonlySet<string> = new Set([
  "soft",
  "medium",
  "hard",
  "intermediate",
  "wet",
]);

/**
 * Plausibility band for a submitted lap, matching the table's CHECK. The
 * point is to reject garbage and typos, not to police the physics - the
 * server enforces the same bounds independently, so this is a courtesy that
 * saves a round trip, not the security boundary.
 */
export const LAP_MIN_MS = 50_000;
export const LAP_MAX_MS = 1_800_000;

/**
 * True when a submission is worth sending. Rejects: non-finite or
 * out-of-band times, unknown compounds, and malformed identity fields. The
 * bounds here are deliberately wider than any real circuit so a legitimate
 * slow lap is never the thing that gets dropped.
 */
export function isSubmittableLap(submission: LapSubmission, knownTrackIds: ReadonlySet<string>): boolean {
  if (!Number.isFinite(submission.lapMs)) return false;
  if (!Number.isInteger(submission.lapMs)) return false;
  if (submission.lapMs < LAP_MIN_MS || submission.lapMs > LAP_MAX_MS) return false;
  if (!knownTrackIds.has(submission.trackId)) return false;
  if (!LEADERBOARD_COMPOUNDS.has(submission.compound)) return false;
  if (submission.driverCode.length < 2 || submission.driverCode.length > 4) return false;
  if (submission.teamId.length < 2 || submission.teamId.length > 40) return false;
  return true;
}

/**
 * Orders a board the way a leaderboard should read: fastest first, and where
 * two times are identical, the earlier submission first (the lap that was set
 * first gets the better row). Returns a NEW array - callers render from it
 * and must not reorder the server's response in place.
 */
export function sortLeaderboard(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  return [...entries].sort((a, b) => {
    if (a.lapMs !== b.lapMs) return a.lapMs - b.lapMs;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });
}

/** `1:23.456`, or null for anything that is not a real lap time. */
export function formatLapTime(lapMs: number): string | null {
  if (!Number.isFinite(lapMs) || lapMs <= 0) return null;
  const totalSeconds = lapMs / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  // Fixed-width seconds so a column of times does not shimmer as they change.
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/** `1:23.456` for a whole number of milliseconds, e.g. 83456. */
export function formatLapTimeFromWholeMs(lapMs: number): string | null {
  return Number.isFinite(lapMs) && Number.isInteger(lapMs) ? formatLapTime(lapMs) : null;
}

const CLIENT_ID_KEY = "lift-and-coast.client-id.v1";

/**
 * A stable anonymous id for this browser, generated once and kept in
 * localStorage. Deliberately not an account: there is nothing to sign up for,
 * nothing personal to leak, and no way to identify a player from the board
 * beyond the car they were driving.
 *
 * Returns null when storage is unavailable (private browsing, blocked
 * cookies), which the caller treats as "don't submit" rather than failing.
 */
export function resolveClientId(storage: Pick<Storage, "getItem" | "setItem"> | null): string | null {
  if (storage === null) return null;
  const existing = storage.getItem(CLIENT_ID_KEY);
  if (existing !== null && isUuid(existing)) return existing;
  const generated = generateUuid();
  try {
    storage.setItem(CLIENT_ID_KEY, generated);
  } catch {
    // Non-fatal: the id is still usable for this session, it just will not
    // persist, so the player looks like a new browser next visit.
  }
  return generated;
}

/** RFC 4122 version 4, from crypto when available and Math.random otherwise. */
export function generateUuid(): string {
  const cryptoObj = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto
    : null;
  if (cryptoObj) return cryptoObj.randomUUID();
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  // Version 4, variant 1, so the value is a well-formed UUID rather than 16
  // random bytes with a hyphen pattern.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

/** Accepts the canonical 8-4-4-4-12 hex form, any version. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Where a lap would rank on the board, 1-based, or null when it would not
 * make the table. `total` is how many rows the board holds.
 */
export function rankForLap(entries: readonly LeaderboardEntry[], lapMs: number): number | null {
  if (!Number.isFinite(lapMs) || entries.length === 0) return null;
  let rank = 1;
  for (const entry of entries) {
    if (entry.lapMs <= lapMs) rank++;
    else break;
  }
  return rank <= entries.length ? rank : null;
}
