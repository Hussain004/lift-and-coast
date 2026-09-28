/**
 * Network layer for the lap-time leaderboard.
 *
 * Everything here is BEST-EFFORT BY CONTRACT. The board is a nice-to-have, so
 * no function rejects and no function throws: a timeout, a 500, an offline
 * device or a misconfigured key all resolve to null or an empty list, and the
 * race carries on untouched. That is why the signatures return values rather
 * than Promises that can fail - there is no error path for a caller to
 * forget to handle.
 *
 * Plain fetch against PostgREST rather than the supabase-js client: the two
 * operations needed here (insert one row, select N for a track) are two HTTP
 * calls, and skipping the dependency keeps it out of the client bundle and
 * out of the lockfile.
 *
 * Only the PUBLISHABLE key is ever used. It is designed to be public and is
 * protected by RLS; the secret service_role key is not needed for a public
 * board and must never reach the client.
 */

import {
  isSubmittableLap,
  sortLeaderboard,
  type LapSubmission,
  type LeaderboardEntry,
} from "./leaderboard";

export interface LeaderboardConfig {
  url: string;
  publishableKey: string;
}

/**
 * Reads the config from the build-time env. Returns null when either value is
 * missing, which is the normal state for a clone that has not been pointed at
 * a project - the board then simply stays empty instead of erroring.
 */
export function leaderboardConfigFromEnv(
  env: Record<string, string | undefined>
): LeaderboardConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  return { url: url.replace(/\/+$/, ""), publishableKey: key };
}

/**
 * Every request is bounded. A leaderboard that hangs is worse than one that is
 * absent, because the player is waiting on it.
 */
const REQUEST_TIMEOUT_MS = 4000;

function headersFor(config: LeaderboardConfig): Record<string, string> {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${config.publishableKey}`,
    "Content-Type": "application/json",
  };
}

/** Maps one database row to the app's shape, or null if the row is unusable. */
export function rowToEntry(row: unknown): LeaderboardEntry | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.track_id !== "string") return null;
  if (typeof r.lap_ms !== "number" || !Number.isFinite(r.lap_ms)) return null;
  if (typeof r.driver_code !== "string") return null;
  if (typeof r.team_id !== "string") return null;
  if (typeof r.compound !== "string") return null;
  return {
    trackId: r.track_id,
    lapMs: r.lap_ms,
    driverCode: r.driver_code,
    teamId: r.team_id,
    compound: r.compound,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
  };
}

/** Query string for the fastest `limit` rows on one track. */
export function buildLeaderboardQuery(trackId: string, limit: number): string {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const params = new URLSearchParams({
    select: "track_id,lap_ms,driver_code,team_id,compound,created_at",
    track_id: `eq.${trackId}`,
    order: "lap_ms.asc",
    limit: String(bounded),
  });
  return `/rest/v1/lap_records?${params.toString()}`;
}

export interface LeaderboardTransport {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * The fastest laps for a circuit, already ordered. Resolves to an empty list
 * on any failure whatsoever.
 */
export async function fetchLeaderboard(
  config: LeaderboardConfig | null,
  trackId: string,
  limit: number,
  transport: LeaderboardTransport = {}
): Promise<LeaderboardEntry[]> {
  if (config === null) return [];
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.url}${buildLeaderboardQuery(trackId, limit)}`, {
      method: "GET",
      headers: headersFor(config),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return [];
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return [];
    const entries: LeaderboardEntry[] = [];
    for (const row of body) {
      const entry = rowToEntry(row);
      if (entry !== null) entries.push(entry);
    }
    // The server already orders by lap_ms; re-sorting is cheap and makes the
    // ordering a property of this module rather than of the query string.
    return sortLeaderboard(entries);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The board for one circuit, straight from the build's env.
 *
 * This is the entry point the UI uses: reading NEXT_PUBLIC_* and turning them
 * into a config is a deployment concern, not something each component should
 * repeat. Returns an empty list when the build was never pointed at a project,
 * which is the normal state for a fresh clone.
 */
export function loadLeaderboardForTrack(trackId: string, limit: number): Promise<LeaderboardEntry[]> {
  return fetchLeaderboard(
    leaderboardConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
    trackId,
    limit
  );
}

/** True when this build was pointed at a leaderboard project at all. */
export function leaderboardIsConfigured(): boolean {
  return (
    leaderboardConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }) !== null
  );
}

/**
 * Submits a lap from the build's env. Resolves false when unconfigured, so a
 * caller can silently skip the submission rather than handling a special case.
 */
export function submitLapFromEnv(
  submission: LapSubmission,
  clientId: string | null,
  knownTrackIds: ReadonlySet<string>
): Promise<boolean> {
  return submitLap(
    leaderboardConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
    submission,
    clientId,
    knownTrackIds
  );
}

/**
 * Submits a lap. Resolves true only when the row was actually stored.
 *
 * `knownTrackIds` gates the submission before the network call; the table's
 * own CHECK constraint is the real boundary and will reject the same things.
 */
export async function submitLap(
  config: LeaderboardConfig | null,
  submission: LapSubmission,
  clientId: string | null,
  knownTrackIds: ReadonlySet<string>,
  transport: LeaderboardTransport = {}
): Promise<boolean> {
  if (config === null || clientId === null) return false;
  if (!isSubmittableLap(submission, knownTrackIds)) return false;
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.url}/rest/v1/lap_records`, {
      method: "POST",
      headers: headersFor(config),
      signal: controller.signal,
      body: JSON.stringify({
        track_id: submission.trackId,
        lap_ms: submission.lapMs,
        driver_code: submission.driverCode,
        team_id: submission.teamId,
        compound: submission.compound,
        client_id: clientId,
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
