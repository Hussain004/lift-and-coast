// Shared Time Trial ghosts: upload the ghost that goes with a posted lap, and
// fetch the next-faster ("rival") or fastest ("world record") one to race.
// Talks to the `ghosts` table (supabase/migrations/20261014000000_ghosts.sql)
// over PostgREST, like the leaderboard. Every call is bounded and resolves to
// null/false on any failure: a ghost is an aid, never a reason for the game to
// fail.

import { headersFor, type LeaderboardConfig, type LeaderboardTransport } from "./leaderboardClient";

const REQUEST_TIMEOUT_MS = 6000;

/** The most base64 text the table accepts (see the migration's check). */
export const MAX_TRACE_BASE64_CHARS = 200000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Null for text that is not valid base64, so a corrupt row never reaches the decoder as garbage. */
export function base64ToBytes(text: string): Uint8Array | null {
  try {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export type SharedGhostKind = "rival" | "world-record";

export interface SharedGhostInfo {
  lapId: string;
  lapMs: number;
  driverCode: string;
  playerName: string | null;
}

/**
 * The query for the ghost to race, or null when there is nothing sensible to
 * ask for. A rival is the closest time FASTER than your own best, so it needs
 * a best to be faster than; the world record is just the fastest there is.
 */
export function buildGhostInfoQuery(
  trackId: string,
  kind: SharedGhostKind,
  personalBestMs: number | null
): string | null {
  const params = new URLSearchParams({
    select: "lap_id,lap_ms,driver_code,player_name",
    track_id: `eq.${trackId}`,
    limit: "1",
  });
  if (kind === "world-record") {
    params.set("order", "lap_ms.asc");
  } else {
    if (personalBestMs === null || !Number.isFinite(personalBestMs)) return null;
    params.set("lap_ms", `lt.${Math.round(personalBestMs)}`);
    params.set("order", "lap_ms.desc");
  }
  return `/rest/v1/ghosts?${params.toString()}`;
}

export function rowToGhostInfo(row: unknown): SharedGhostInfo | null {
  if (typeof row !== "object" || row === null) return null;
  const r = row as Record<string, unknown>;
  if (typeof r.lap_id !== "string" || typeof r.lap_ms !== "number" || !Number.isFinite(r.lap_ms)) return null;
  if (typeof r.driver_code !== "string") return null;
  return {
    lapId: r.lap_id,
    lapMs: r.lap_ms,
    driverCode: r.driver_code,
    playerName: typeof r.player_name === "string" ? r.player_name : null,
  };
}

async function request(
  config: LeaderboardConfig,
  path: string,
  init: { method: "GET" | "POST"; body?: string; accessToken?: string; extraHeaders?: Record<string, string> },
  transport: LeaderboardTransport
): Promise<Response | null> {
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    return await doFetch(`${config.url}${path}`, {
      method: init.method,
      headers: { ...headersFor(config, init.accessToken), ...(init.extraHeaders ?? {}) },
      body: init.body,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Which ghost is available, without downloading its trace. Null when there is none. */
export async function fetchGhostInfo(
  config: LeaderboardConfig | null,
  trackId: string,
  kind: SharedGhostKind,
  personalBestMs: number | null,
  transport: LeaderboardTransport = {}
): Promise<SharedGhostInfo | null> {
  if (config === null) return null;
  const query = buildGhostInfoQuery(trackId, kind, personalBestMs);
  if (query === null) return null;
  const res = await request(config, query, { method: "GET" }, transport);
  if (res === null || !res.ok) return null;
  try {
    const body: unknown = await res.json();
    return Array.isArray(body) && body.length > 0 ? rowToGhostInfo(body[0]) : null;
  } catch {
    return null;
  }
}

/** The raw ghost blob for a lap, or null. Decoding and validating it is the caller's job. */
export async function fetchGhostTrace(
  config: LeaderboardConfig | null,
  lapId: string,
  transport: LeaderboardTransport = {}
): Promise<Uint8Array | null> {
  if (config === null || !/^[0-9a-f-]{36}$/i.test(lapId)) return null;
  const params = new URLSearchParams({ select: "trace", lap_id: `eq.${lapId}`, limit: "1" });
  const res = await request(config, `/rest/v1/ghosts?${params.toString()}`, { method: "GET" }, transport);
  if (res === null || !res.ok) return null;
  try {
    const body: unknown = await res.json();
    const trace = Array.isArray(body) && body.length > 0 ? (body[0] as { trace?: unknown }).trace : null;
    return typeof trace === "string" ? base64ToBytes(trace) : null;
  } catch {
    return null;
  }
}

export interface GhostUpload {
  lapId: string;
  trackId: string;
  lapMs: number;
  driverCode: string;
  /** Must equal the lap row's client_id (the account id when signed in). */
  clientId: string;
  playerName?: string;
  bytes: Uint8Array;
}

/** Resolves true only when the row was stored. */
export async function submitGhost(
  config: LeaderboardConfig | null,
  upload: GhostUpload,
  accessToken?: string,
  transport: LeaderboardTransport = {}
): Promise<boolean> {
  if (config === null) return false;
  const trace = bytesToBase64(upload.bytes);
  if (trace.length > MAX_TRACE_BASE64_CHARS) return false;
  const res = await request(
    config,
    "/rest/v1/ghosts",
    {
      method: "POST",
      accessToken,
      body: JSON.stringify({
        lap_id: upload.lapId,
        track_id: upload.trackId,
        lap_ms: Math.round(upload.lapMs),
        driver_code: upload.driverCode,
        client_id: upload.clientId,
        ...(upload.playerName !== undefined ? { player_name: upload.playerName } : {}),
        trace,
      }),
    },
    transport
  );
  return res !== null && res.ok;
}
