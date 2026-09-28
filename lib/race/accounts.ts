/**
 * Player accounts: usernames, and the mapping from a username to the
 * sign-in address Supabase Auth authenticates.
 *
 * PURE, so every rule that decides whether a name is legal - and the mapping
 * that decides whose row a lap may claim - is unit-testable without a network
 * or a DOM.
 *
 * WHY THE SYNTHETIC ADDRESS EXISTS. Supabase's password auth is built around
 * email addresses, and this feature wants a game handle, not an inbox. Rather
 * than inventing our own password storage (which would mean shipping auth code
 * and, done in the browser, would make the "hash" the password), the username
 * is mapped to an address on a domain we control the configuration of:
 * "max" signs in as "max@liftandcoast.app". GoTrue still hashes the password
 * server-side with bcrypt and the plaintext never leaves the browser, so this
 * is real authentication - it is only the identifier that is synthetic.
 *
 * IT REQUIRES EMAIL CONFIRMATION TO BE OFF on the project, and that is worth
 * being explicit about because it is a real trade rather than a free win.
 * With confirmation on, every signup needs a clickable email, and a synthetic
 * address can never receive one, so NO account could ever be created. It is
 * off, which is acceptable here precisely because the account carries no
 * privilege: it tags your own lap rows and grants nothing else. Anyone can
 * claim any handle, so a handle is a nickname and NOT verified identity - the
 * UI says so in as many words, and the board must not treat a username as
 * proof of anything. Supabase's own rate limit (30 signups per 5 minutes per
 * IP) is what bounds abuse.
 *
 * A CONSEQUENCE WORTH KNOWING: because anyone can take any handle, two players
 * can pick the same one. The board's 2-4 character driver_code cannot tell
 * them apart either, which is why the full username is stored alongside it
 * (player_name) and why the board shows that where it has one.
 */

/**
 * The domain synthetic accounts live on. Chosen because Supabase's email
 * validator accepts it: it rejects reserved names like example.com outright,
 * and this one was verified against the live project rather than assumed.
 */
export const ACCOUNT_DOMAIN = "liftandcoast.app";

/**
 * Supabase's hosted projects enforce their own minimum, and the local dev
 * config in supabase/config.toml sets 6. We ask for more than the floor we
 * know about so a weak password is refused here with a clear message rather
 * than accepted here and turned down by the server.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 72;
/**
 * bcrypt (which GoTrue uses) silently truncates beyond 72 bytes, so anything
 * past this contributes nothing but a false sense of strength.
 */
export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 20;

/**
 * Handles that would read as something they are not. These are mostly
 * rejected because they become the local part of an email address, where
 * "admin@..." and "postmaster@..." invite exactly the misreading a real
 * operator mail would.
 */
const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "administrator",
  "anonymous",
  "api",
  "auth",
  "billing",
  "hostmaster",
  "info",
  "null",
  "postmaster",
  "root",
  "security",
  "support",
  "system",
  "webmaster",
]);

export type UsernameProblem =
  | "empty"
  | "too-short"
  | "too-long"
  | "bad-characters"
  | "must-start-with-letter"
  | "reserved";

/**
 * Canonical form of a typed handle: trimmed and lowercased.
 *
 * Deliberately does NOT strip invalid characters. Silently deleting them would
 * make "ma x" and "maxx" the same account, and a player whose handle came out
 * different from what they typed would be quietly signed into somebody else's
 * lap times. Reject instead, with a reason the UI can show.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why this handle is unusable, or null when it is fine. */
export function usernameProblem(raw: string): UsernameProblem | null {
  const username = normalizeUsername(raw);
  if (username.length === 0) return "empty";
  if (username.length < MIN_USERNAME_LENGTH) return "too-short";
  if (username.length > MAX_USERNAME_LENGTH) return "too-long";
  // A-Za-z0-9_ only, checked after lowercasing. No dots, no spaces, no
  // non-ASCII: the handle becomes an email local part, and the local part's
  // quoting rules are a trap not worth walking into.
  if (!/^[a-z0-9_]+$/.test(username)) return "bad-characters";
  if (!/^[a-z]/.test(username)) return "must-start-with-letter";
  if (RESERVED_USERNAMES.has(username)) return "reserved";
  return null;
}

export function isValidUsername(raw: string): boolean {
  return usernameProblem(raw) === null;
}

/** The address a handle signs in at. Assumes the handle is already valid. */
export function syntheticEmailFor(username: string): string {
  return `${normalizeUsername(username)}@${ACCOUNT_DOMAIN}`;
}

/**
 * The handle back out of an address this module produced. Returns null for
 * anything else, so a row or token from a real email login cannot be
 * mislabelled as a handle.
 */
export function usernameFromSyntheticEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  if (email.slice(at + 1).toLowerCase() !== ACCOUNT_DOMAIN) return null;
  const local = email.slice(0, at).toLowerCase();
  return isValidUsername(local) ? local : null;
}

export type PasswordProblem = "empty" | "too-short" | "too-long";

export function passwordProblem(raw: string): PasswordProblem | null {
  if (raw.length === 0) return "empty";
  if (raw.length < MIN_PASSWORD_LENGTH) return "too-short";
  if (raw.length > MAX_PASSWORD_LENGTH) return "too-long";
  return null;
}

/** A signed-in player, as far as the rest of the app is concerned. */
export interface AccountSession {
  /** The player's JWT. Sent as the Authorization bearer so PostgREST sets
   *  auth.uid() and RLS can check it. Never the publishable key, once signed
   *  in. */
  accessToken: string;
  /** Used to mint a new access token when the old one expires. */
  refreshToken: string;
  /** Epoch ms, so expiry is decided without trusting a stored clock offset. */
  expiresAtMs: number;
  /** auth.users id: what a lap row is allowed to claim. */
  userId: string;
  /** The player's handle, for display. */
  username: string;
}

/** Decode a JWT payload WITHOUT verifying it. */
export function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    // base64url -> base64, then padded, because atob is strict about both.
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = globalThis.atob(padded);
    const claims: unknown = JSON.parse(json);
    if (typeof claims !== "object" || claims === null) return null;
    return claims as Record<string, unknown>;
  } catch {
    // A malformed token is a missing token as far as any caller is concerned.
    return null;
  }
}

/**
 * Pull a session out of a raw GoTrue sign-in response.
 *
 * Returns null unless the response carries BOTH a usable access token and a
 * subject, because a half-built session is worse than none: it would look
 * signed in and then fail every privileged write.
 *
 * The username is read from user_metadata, which is what we wrote at signup.
 * It falls back to the address's local part for the same handle, and to null
 * if neither works - a null username is handled by showing the sign-in form
 * again rather than by inventing a name.
 */
export function sessionFromAuthResponse(
  response: unknown,
  nowMs: number
): AccountSession | null {
  if (typeof response !== "object" || response === null) return null;
  const r = response as Record<string, unknown>;
  const accessToken = r.access_token;
  const refreshToken = r.refresh_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) return null;

  const claims = decodeJwtClaims(accessToken);
  const subject = claims?.sub;
  if (typeof subject !== "string" || subject.length === 0) return null;

  const expiresIn = typeof r.expires_in === "number" ? r.expires_in : 3600;
  const expiresAtSeconds = typeof claims?.exp === "number" ? claims.exp : null;

  const user = r.user;
  const metadata =
    typeof user === "object" && user !== null
      ? (user as Record<string, unknown>).user_metadata
      : undefined;
  const fromMetadata =
    typeof metadata === "object" && metadata !== null
      ? (metadata as Record<string, unknown>).username
      : undefined;
  const email = typeof r.email === "string" ? r.email : null;
  const username =
    typeof fromMetadata === "string" && isValidUsername(fromMetadata)
      ? normalizeUsername(fromMetadata)
      : email !== null
        ? usernameFromSyntheticEmail(email)
        : null;

  return {
    accessToken,
    refreshToken: typeof refreshToken === "string" ? refreshToken : "",
    expiresAtMs:
      expiresAtSeconds !== null
        ? expiresAtSeconds * 1000
        : nowMs + expiresIn * 1000,
    userId: subject,
    username: username ?? "",
  };
}

/**
 * True when the session is close enough to expiry that a write could be
 * rejected mid-request. A minute of headroom, so a submit cannot start with a
 * valid token and lose the row to a refresh landing first.
 */
export function sessionNeedsRefresh(session: AccountSession, nowMs: number): boolean {
  return session.expiresAtMs - nowMs <= 60_000;
}
