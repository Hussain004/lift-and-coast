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
  bestPerPlayer,
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

/**
 * The bearer to send.
 *
 * With no session this is the publishable key - the anonymous role - which is
 * the behaviour that has always worked and still does, so an unconfigured build
 * and a player who never signed in are both unaffected.
 *
 * With a session it is the player's own JWT, which is what makes PostgREST set
 * auth.uid() and lets the insert policy check that a claimed user_id really is
 * the caller. The apikey header stays the publishable key either way: that is
 * the project identifier, not the identity.
 */
function headersFor(config: LeaderboardConfig, accessToken?: string): Record<string, string> {
  return {
    apikey: config.publishableKey,
    Authorization: `Bearer ${accessToken ?? config.publishableKey}`,
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
    // Both present only on rows set while signed in. player_name is only ever
    // a display name - anyone can hold any handle, so it tells two rows apart
    // without proving who set either.
    playerName: typeof r.player_name === "string" && r.player_name.length > 0 ? r.player_name : null,
    userId: typeof r.user_id === "string" ? r.user_id : null,
    // Always written (the column is NOT NULL) but read defensively: this row
    // mapper also has to cope with a board written by an older build, and a
    // missing id must not throw mid-list.
    clientId: typeof r.client_id === "string" ? r.client_id : null,
  };
}

/** Query string for the fastest `limit` rows on one track. */
export function buildLeaderboardQuery(trackId: string, limit: number): string {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const params = new URLSearchParams({
    // client_id is the anonymous per-browser identity and the only id an
    // unsigned row has, so it has to be read for "one row per player" to work
    // for anyone who is not signed in.
    select:
      "track_id,lap_ms,driver_code,team_id,compound,created_at,player_name,user_id,client_id",
    track_id: `eq.${trackId}`,
    order: "lap_ms.asc",
    limit: String(bounded),
  });
  return `/rest/v1/lap_records?${params.toString()}`;
}

/**
 * Query string for one player's fastest lap on each circuit.
 *
 * NOT a security boundary, and deliberately not treated as one: the select
 * policy is public, so every row here is already readable by anyone. This is a
 * convenience filter that happens to match what a player means by "my times",
 * not a private store. That is also why it needs no session token - sending
 * one would imply the rows were private, and they are not.
 */
export function buildMyTimesQuery(userId: string, limit: number): string {
  const bounded = Math.max(1, Math.min(200, Math.floor(limit)));
  const params = new URLSearchParams({
    select: "track_id,lap_ms,driver_code,team_id,compound,created_at,player_name,user_id",
    user_id: `eq.${userId}`,
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
 * How many rows to ask for when the caller wants `limit` PLAYERS on the board.
 *
 * The board shows one row per player (see bestPerPlayer), so asking the
 * server for exactly `limit` rows and deduplicating afterwards can return far
 * fewer than `limit` players - five rows from two prolific drivers is two
 * rows, and the board reads as empty when it is not. Over-fetching lets the
 * collapse happen against a deeper slice.
 *
 * Bounded at the query's own 100-row cap, so this stays a cheap indexed read
 * of a public table rather than an open-ended pull. The honest limit: this
 * reduces the crowding, it does not eliminate it. A player with more than
 * `limit * OVERFETCH_PER_PLAYER` laps can still fill the slice alone. Removing
 * that possibility entirely needs the collapse in the database - a view doing
 * `distinct on (track_id, coalesce(user_id::text, client_id::text))` - rather
 * than in the client, and is the version to build if the board ever shows
 * short for a reason other than an empty circuit.
 */
const OVERFETCH_PER_PLAYER = 20;

function overfetchFor(limit: number): number {
  const wanted = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  return Math.min(100, wanted * OVERFETCH_PER_PLAYER);
}

/**
 * The fastest laps for a circuit, one row per player, already ordered.
 * Resolves to an empty list on any failure whatsoever.
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
    const res = await doFetch(`${config.url}${buildLeaderboardQuery(trackId, overfetchFor(limit))}`, {
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
    // Then one row per player, then the caller's limit - in that order, or the
    // limit would be applied to laps rather than to people.
    return bestPerPlayer(sortLeaderboard(entries), limit);
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

/**
 * A player's own lap times, fastest first, across every circuit. Resolves to
 * an empty list on any failure - a signed-in player whose history fails to
 * load sees no history, not a broken page.
 *
 * Takes the user id as an argument rather than reading a session, so the caller
 * decides what "mine" means and this stays a pure query over a public table.
 */
export async function loadMyTimes(
  userId: string,
  limit = 30,
  transport: LeaderboardTransport = {}
): Promise<LeaderboardEntry[]> {
  const config = leaderboardConfigFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  if (config === null || userId.length === 0) return [];
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.url}${buildMyTimesQuery(userId, limit)}`, {
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
    return sortLeaderboard(entries);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
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
  knownTrackIds: ReadonlySet<string>,
  accessToken?: string
): Promise<boolean> {
  return submitLap(
    leaderboardConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }),
    submission,
    clientId,
    knownTrackIds,
    {},
    accessToken
  );
}

/**
 * Submits a lap. Resolves true only when the row was actually stored.
 *
 * `knownTrackIds` gates the submission before the network call; the table's
 * own CHECK constraint is the real boundary and will reject the same things.
 *
 * `accessToken`, when present, is sent as the bearer so the row can carry an
 * authenticated `user_id`. The table's insert policy is what actually decides
 * whether a claimed identity is accepted, so a token that does not match the
 * claimed id fails the write here rather than storing a false attribution.
 */
export async function submitLap(
  config: LeaderboardConfig | null,
  submission: LapSubmission,
  clientId: string | null,
  knownTrackIds: ReadonlySet<string>,
  transport: LeaderboardTransport = {},
  accessToken?: string
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
      headers: headersFor(config, accessToken),
      signal: controller.signal,
      body: JSON.stringify({
        track_id: submission.trackId,
        lap_ms: submission.lapMs,
        driver_code: submission.driverCode,
        team_id: submission.teamId,
        compound: submission.compound,
        client_id: clientId,
        // Omitted rather than sent as null when there is no account, so an
        // anonymous lap is byte-for-byte the request it always was.
        ...(submission.userId !== undefined ? { user_id: submission.userId } : {}),
        ...(submission.playerName !== undefined
          ? { player_name: submission.playerName }
          : {}),
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
