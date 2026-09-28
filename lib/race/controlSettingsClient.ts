/**
 * Syncing control settings with a signed-in account.
 *
 * LOCAL FIRST, ACCOUNT SECOND. The local copy in controlStorage.ts is what
 * actually drives the car, and it is what every player has whether or not they
 * ever sign in. This module is the optional second copy: it pushes the local
 * settings up to `control_settings` when signed in, and pulls them back down on
 * a later visit. Nothing here is on the path to driving - it is fire and
 * forget.
 *
 * BEST-EFFORT BY CONTRACT, same as every other module in this area: a timeout,
 * a 500, an expired token or an unreachable project resolve to false/an empty
 * result. A player whose sync fails keeps their local settings and is never
 * blocked, never retried against, and never shown a modal about it.
 *
 * The table is RLS-locked to `auth.uid() = user_id`, so the client sends the
 * player's own JWT as the bearer and PostgREST checks the claim. The write is
 * an UPSERT (POST with `Prefer: resolution=merge-duplicates`) so one round
 * trip covers both "first save" and "update" and there is no separate insert
 * path to get wrong.
 */

import {
  leaderboardConfigFromEnv,
  type LeaderboardConfig,
  type LeaderboardTransport,
} from "./leaderboardClient";
import type { AccountSession } from "./accounts";
import {
  normalizeBindings,
  normalizeSettings,
  type ControlBindings,
  type ControlSettings,
} from "../input/keyBindings";

/** The two objects the table stores, as one payload. */
export interface StoredControlsPayload {
  bindings: ControlBindings;
  settings: ControlSettings;
}

export interface ControlSyncOptions {
  session: AccountSession | null;
  transport?: LeaderboardTransport;
  /**
   * Overrides where the row goes. Present (even as null) means "use exactly
   * this and do not read the environment" - the same seam leaderboardClient
   * exposes so a test can exercise the real request path with no configured
   * build.
   */
  config?: LeaderboardConfig | null;
}

/** Not signed in: nothing to sync, and that is not an error. */
function noSession(): boolean {
  return false;
}

function requestHeaders(
  config: LeaderboardConfig,
  accessToken: string
): Record<string, string> {
  return {
    apikey: config.publishableKey,
    // The player's own JWT, NOT the publishable key: this is what lets
    // PostgREST compare the claimed user id against auth.uid() and apply the
    // row-level policy.
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

function resolveConfig(options: ControlSyncOptions): LeaderboardConfig | null {
  if (options.config !== undefined) return options.config;
  return leaderboardConfigFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

/**
 * The row a control set becomes. Pure, so what is stored is testable without
 * a network, and so the local and remote shapes are guaranteed identical -
 * a mismatch here is the kind of thing that silently resets a player's
 * bindings on their next visit.
 */
export function controlSettingsRow(
  session: AccountSession | null,
  controls: StoredControlsPayload
): { user_id: string; bindings: ControlBindings; settings: ControlSettings } | null {
  if (session === null) return null;
  return {
    user_id: session.userId,
    bindings: normalizeBindings(controls.bindings),
    settings: normalizeSettings(controls.settings),
  };
}

/**
 * Maps a fetched row back into control settings, or null when the row is
 * unusable. Normalizing on the way IN matters: the database is the far side of
 * a network, so its contents are not trusted to be well formed.
 */
export function controlSettingsFromRow(
  row: unknown
): StoredControlsPayload | null {
  if (typeof row !== "object" || row === null) return null;
  const record = row as Record<string, unknown>;
  // A row with no bindings and no settings is not a control set; treat it as
  // "nothing saved yet" so the caller keeps the local defaults rather than
  // blanking the player's controls.
  if (record.bindings === undefined && record.settings === undefined) return null;
  return {
    bindings: normalizeBindings(record.bindings),
    settings: normalizeSettings(record.settings),
  };
}

/**
 * Pushes the local control set up to the account. Resolves true only when the
 * row was actually written.
 */
export async function pushControlSettings(
  options: ControlSyncOptions,
  controls: StoredControlsPayload
): Promise<boolean> {
  const { session } = options;
  if (session === null) return noSession();
  const config = resolveConfig(options);
  if (config === null) return false;
  const row = controlSettingsRow(session, controls);
  if (row === null) return false;
  const doFetch = options.transport?.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.transport?.timeoutMs ?? 4000
  );
  try {
    const res = await doFetch(`${config.url}/rest/v1/control_settings`, {
      method: "POST",
      headers: {
        ...requestHeaders(config, session.accessToken),
        // UPSERT: one round trip for both first save and update. The primary
        // key is user_id, so this merges on it.
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      signal: controller.signal,
      body: JSON.stringify(row),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pulls the account's control set down. Resolves null when there is nothing
 * stored yet, and ALSO when the read fails - the caller cannot tell the
 * difference, and that is deliberate: a failed read must not be able to look
 * like "the account has no settings", because the response to that would be to
 * overwrite what the player has locally.
 */
export async function pullControlSettings(
  options: ControlSyncOptions
): Promise<StoredControlsPayload | null> {
  const { session } = options;
  if (session === null) return null;
  const config = resolveConfig(options);
  if (config === null) return null;
  const doFetch = options.transport?.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.transport?.timeoutMs ?? 4000
  );
  try {
    const res = await doFetch(
      // Select on the session's own id as well as carrying the JWT: belt and
      // braces, so a policy change could not widen this into someone else's
      // settings.
      `${config.url}/rest/v1/control_settings?user_id=eq.${encodeURIComponent(
        session.userId
      )}&select=bindings,settings&limit=1`,
      {
        method: "GET",
        headers: requestHeaders(config, session.accessToken),
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body) || body.length === 0) return null;
    return controlSettingsFromRow(body[0]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole round trip in one call: push the local set up, then read it back.
 *
 * Push-then-pull rather than just push, because it is the only way to be sure
 * the two agree: if the write silently did not land (a policy rejecting it, a
 * column the server ignored), the read returns the account's previous value and
 * the caller can tell there is a disagreement to show the player, instead of
 * reporting a sync that did not happen.
 */
export async function syncControlSettings(
  options: ControlSyncOptions,
  controls: StoredControlsPayload
): Promise<{ pushed: boolean; pulled: StoredControlsPayload | null }> {
  const pushed = await pushControlSettings(options, controls);
  const pulled = await pullControlSettings(options);
  return { pushed, pulled };
}
