/**
 * The network half of player accounts: GoTrue (Supabase's auth service) over
 * plain fetch.
 *
 * Plain fetch rather than supabase-js, for the same reason
 * leaderboardClient.ts avoids it: the four calls needed here are four HTTP
 * requests, and skipping the dependency keeps it out of the client bundle and
 * out of the lockfile. Consistency with the existing client matters as much as
 * the bytes - the next person to touch auth should find the same shape they
 * already know.
 *
 * EVERYTHING HERE IS BEST-EFFORT BY CONTRACT, and more strongly than the
 * leaderboard's is, because this one touches a password. Nothing rejects and
 * nothing throws: a failure, a timeout, an offline device, a misconfigured key
 * and a rejected handle all resolve to a result object the UI can show a line
 * of copy about. There is no error path a caller can forget to handle, and no
 * way for a failed sign-in to take the lap-time page down with it.
 *
 * THE PASSWORD IS NEVER STORED, never logged, and never put anywhere but the
 * body of the one request that needs it. What IS stored is the session (see
 * lib/race/accounts.ts) - the JWT, a refresh token, an expiry and a handle.
 * That is the same thing supabase-js puts in localStorage for a single-page
 * app; it is readable by any script on the page, which is the honest cost of a
 * no-server app and the reason the session grants nothing but authorship of
 * your own rows.
 */

import {
  ACCOUNT_DOMAIN,
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  isValidUsername,
  normalizeUsername,
  passwordProblem,
  sessionFromAuthResponse,
  syntheticEmailFor,
  usernameProblem,
  type AccountSession,
} from "./accounts";

/** Every request is bounded. A login that hangs is worse than one that fails. */
const REQUEST_TIMEOUT_MS = 8000;

export type AuthErrorCode =
  | "invalid-username"
  | "invalid-password"
  | "invalid-credentials"
  | "username-taken"
  | "not-configured"
  | "rate-limited"
  | "network"
  | "unknown";

export interface AuthResult {
  ok: boolean;
  session: AccountSession | null;
  code: AuthErrorCode | null;
  /** Short, safe to show. Never echoes the password or the full address. */
  message: string | null;
}

function failure(code: AuthErrorCode, message: string): AuthResult {
  return { ok: false, session: null, code, message };
}

export interface AuthTransport {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Overrides where the project is read from. Present (even as null) means
   * "use exactly this and do not read the environment" - which is what lets a
   * test exercise the real request path without a configured build, and is the
   * same seam leaderboardClient.ts exposes through leaderboardConfigFromEnv.
   */
  config?: AuthProjectConfig | null;
}

export interface AuthProjectConfig {
  url: string;
  /** The publishable key. The secret service_role key is never used and never
   *  belongs here. */
  key: string;
}

function authConfigFromEnv(
  env: Record<string, string | undefined>
): { url: string; key: string } | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof key !== "string" || key.length === 0) return null;
  return { url: url.replace(/\/+$/, ""), key };
}

/** The publishable key alone, for the calls that need no session. */
export function accountsConfigured(): boolean {
  return (
    authConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    }) !== null
  );
}

/**
 * Maps GoTrue's own error vocabulary onto ours, so the UI never has to know
 * Supabase's spelling and a copy change never needs a network change.
 *
 * Note the deliberate lumping of "no such user" and "wrong password" into one
 * code: GoTrue already returns the same error for both, and preserving that is
 * the point - a sign-in form that says "no such username" is a free account
 * enumerator for anyone with a script.
 */
function classify(errorCode: string | null, status: number): AuthErrorCode {
  switch (errorCode) {
    case "invalid_credentials":
      return "invalid-credentials";
    case "user_already_exists":
    case "email_exists":
      return "username-taken";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit":
    case "over_signups_rate_limit":
      return "rate-limited";
    case "weak_password":
    case "password_too_short":
    case "password_too_long":
      return "invalid-password";
    default:
      break;
  }
  if (status === 429) return "rate-limited";
  if (status === 0) return "network";
  if (status === 400 || status === 401 || status === 403) return "invalid-credentials";
  return "unknown";
}

const MESSAGES: Record<AuthErrorCode, string> = {
  "invalid-username": "Pick a handle of 3-20 letters, numbers or underscores.",
  "invalid-password": `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
  "invalid-credentials": "That handle and password do not match.",
  "username-taken": "That handle is taken.",
  "not-configured": "Accounts are unavailable on this build.",
  "rate-limited": "Too many attempts. Wait a minute and try again.",
  network: "Could not reach the server. Check your connection.",
  unknown: "Something went wrong. Try again.",
};

async function post(
  config: { url: string; key: string },
  path: string,
  body: unknown,
  transport: AuthTransport
): Promise<{ status: number; data: unknown }> {
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return { status: 0, data: null };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.url}${path}`, {
      method: "POST",
      headers: {
        apikey: config.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      // A body-less error response is still a response.
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

function envConfig(transport: AuthTransport): AuthProjectConfig | null {
  if (transport.config !== undefined) return transport.config;
  return authConfigFromEnv({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
}

/**
 * Creates an account. The handle is checked locally first so an obviously
 * illegal one never becomes a network round trip or an error message
 * somebody can trigger for someone else.
 */
export async function signUp(
  username: string,
  password: string,
  transport: AuthTransport = {}
): Promise<AuthResult> {
  if (usernameProblem(username) !== null) {
    return failure("invalid-username", MESSAGES["invalid-username"]);
  }
  if (passwordProblem(password) !== null) {
    return failure("invalid-password", MESSAGES["invalid-password"]);
  }
  const config = envConfig(transport);
  if (config === null) return failure("not-configured", MESSAGES["not-configured"]);

  const handle = normalizeUsername(username);
  const { status, data } = await post(
    config,
    "/auth/v1/signup",
    {
      email: syntheticEmailFor(handle),
      password,
      // Kept so the handle survives into the JWT, which is where the app reads
      // it back from. This is a display name, not verified anything.
      data: { username: handle },
    },
    transport
  );

  if (status >= 200 && status < 300) {
    const session = sessionFromAuthResponse(data, Date.now());
    if (session !== null) {
      return { ok: true, session, code: null, message: null };
    }
    // A 2xx with no usable session is what an account awaiting email
    // confirmation looks like. Said plainly rather than as a generic failure,
    // because otherwise this reads as "the server is broken".
    return failure(
      "not-configured",
      "This build needs email confirmation turned off before accounts can be created."
    );
  }

  const errorCode =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).error_code
      : null;
  const code = classify(typeof errorCode === "string" ? errorCode : null, status);
  return failure(code, MESSAGES[code]);
}

/** Signs an existing account in. */
export async function signIn(
  username: string,
  password: string,
  transport: AuthTransport = {}
): Promise<AuthResult> {
  if (usernameProblem(username) !== null) {
    return failure("invalid-username", MESSAGES["invalid-username"]);
  }
  if (password === "") {
    return failure("invalid-password", MESSAGES["invalid-password"]);
  }
  const config = envConfig(transport);
  if (config === null) return failure("not-configured", MESSAGES["not-configured"]);

  const { status, data } = await post(
    config,
    "/auth/v1/token?grant_type=password",
    { email: syntheticEmailFor(username), password },
    transport
  );

  if (status >= 200 && status < 300) {
    const session = sessionFromAuthResponse(data, Date.now());
    if (session !== null) return { ok: true, session, code: null, message: null };
    return failure("unknown", MESSAGES.unknown);
  }

  const errorCode =
    typeof data === "object" && data !== null
      ? (data as Record<string, unknown>).error_code
      : null;
  const code = classify(typeof errorCode === "string" ? errorCode : null, status);
  return failure(code, MESSAGES[code]);
}

/** Mints a fresh access token from a refresh token. */
export async function refreshSession(
  session: AccountSession,
  transport: AuthTransport = {}
): Promise<AuthResult> {
  const config = envConfig(transport);
  if (config === null) return failure("not-configured", MESSAGES["not-configured"]);
  if (session.refreshToken === "") return failure("invalid-credentials", MESSAGES["invalid-credentials"]);

  const { status, data } = await post(
    config,
    "/auth/v1/token?grant_type=refresh_token",
    { refresh_token: session.refreshToken },
    transport
  );

  if (status >= 200 && status < 300) {
    const next = sessionFromAuthResponse(data, Date.now());
    if (next !== null) {
      // GoTrue may omit the refresh token on a refresh. Keeping the old one is
      // correct, not a shortcut: the new access token was minted FROM it, so it
      // is still the live one.
      return {
        ok: true,
        session: { ...next, refreshToken: next.refreshToken || session.refreshToken },
        code: null,
        message: null,
      };
    }
  }
  return failure("invalid-credentials", MESSAGES["invalid-credentials"]);
}

/** Ends the session. Best effort: a failure here must not sign anyone out
 *  locally, because a stranded session is recoverable and a silently dropped
 *  one is not. */
export async function signOut(session: AccountSession, transport: AuthTransport = {}): Promise<boolean> {
  const config = envConfig(transport);
  if (config === null) return false;
  const doFetch = transport.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), transport.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    const res = await doFetch(`${config.url}/auth/v1/logout`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: controller.signal,
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Session storage
// ---------------------------------------------------------------------------

const SESSION_KEY = "lift-and-coast.account-session.v1";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads a stored session, or null. A stored value that does not parse, or that
 * is missing any of its four fields, is treated as absent AND cleared: a
 * half-restored session would render as signed in and then fail every write.
 */
export function loadAccountSession(
  storage: Storage | null = defaultStorage(),
  nowMs: number = Date.now()
): AccountSession | null {
  if (storage === null) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("shape");
    const s = parsed as Record<string, unknown>;
    if (typeof s.accessToken !== "string" || s.accessToken.length === 0) throw new Error("token");
    if (typeof s.userId !== "string" || s.userId.length === 0) throw new Error("user");
    if (typeof s.expiresAtMs !== "number" || !Number.isFinite(s.expiresAtMs)) throw new Error("exp");
    const session: AccountSession = {
      accessToken: s.accessToken,
      refreshToken: typeof s.refreshToken === "string" ? s.refreshToken : "",
      expiresAtMs: s.expiresAtMs,
      userId: s.userId,
      username: typeof s.username === "string" ? s.username : "",
    };
    // A session that expired while the tab was shut is not a session. Dropping
    // it here means the sign-in form is what the player sees, rather than a
    // signed-in header whose every action silently fails.
    if (session.expiresAtMs <= nowMs && session.refreshToken === "") {
      clearAccountSession(storage);
      return null;
    }
    return session;
  } catch {
    clearAccountSession(storage);
    return null;
  }
}

export function saveAccountSession(
  session: AccountSession,
  storage: Storage | null = defaultStorage()
): void {
  if (storage === null) return;
  try {
    storage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private mode, blocked cookies, or a full quota. The player stays signed
    // in for this page view; only the "stay signed in" convenience is lost.
  }
}

export function clearAccountSession(storage: Storage | null = defaultStorage()): void {
  if (storage === null) return;
  try {
    storage.removeItem(SESSION_KEY);
  } catch {
    // Nothing useful to do; the caller clears its own state regardless.
  }
}

export { ACCOUNT_DOMAIN, isValidUsername, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH };
