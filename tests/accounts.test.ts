import { describe, expect, it } from "vitest";
import {
  ACCOUNT_DOMAIN,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  decodeJwtClaims,
  isValidUsername,
  normalizeUsername,
  passwordProblem,
  sessionFromAuthResponse,
  sessionNeedsRefresh,
  syntheticEmailFor,
  usernameFromSyntheticEmail,
  usernameProblem,
} from "../lib/race/accounts";
import {
  accountsConfigured,
  clearAccountSession,
  loadAccountSession,
  refreshSession,
  saveAccountSession,
  signIn,
  signOut,
  signUp,
  type AuthTransport,
} from "../lib/race/authClient";
import { buildMyTimesQuery, rowToEntry, submitLap } from "../lib/race/leaderboardClient";
import { TRACKS } from "../lib/tracks/registry";

/**
 * Accounts decide who a lap time belongs to, and a password is involved, so
 * these tests lean on two properties: that a handle is only ever mapped to an
 * address THIS module would have produced, and that nothing in the network
 * layer can throw at a caller. The second is what keeps a failed sign-in from
 * taking the lap-time page down with it.
 *
 * The RLS that actually stops one player claiming another's rows is not here,
 * because it is not TypeScript. It was verified against the live project and
 * the check is recorded in the migration that tightened the policy.
 */

const TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));

/** Base64url of a JSON payload, the way a JWT carries one. */
function fakeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

describe("usernames", () => {
  it("accepts ordinary handles and trims and lowercases them", () => {
    for (const handle of ["max", "hussain04", "Lando_Norris", "a_b_c", "verstappen1"]) {
      expect(isValidUsername(handle), handle).toBe(true);
    }
    expect(normalizeUsername("  MaxVerstappen ")).toBe("maxverstappen");
    expect(normalizeUsername("LANDO")).toBe("lando");
  });

  it("rejects a handle that cannot become a local part", () => {
    // These are the ones that would need email quoting rules to survive, which
    // is a trap not worth walking into for a game handle.
    for (const handle of ["a b", "a.b", "a@b", "a+b", "ünicode", "a/b", "a:b"]) {
      expect(isValidUsername(handle), handle).toBe(false);
    }
  });

  it("bounds the length at both ends, with a reason for each", () => {
    expect(usernameProblem("a".repeat(MIN_USERNAME_LENGTH - 1))).toBe("too-short");
    expect(usernameProblem("a".repeat(MIN_USERNAME_LENGTH))).toBeNull();
    expect(usernameProblem("a".repeat(MAX_USERNAME_LENGTH))).toBeNull();
    expect(usernameProblem("a".repeat(MAX_USERNAME_LENGTH + 1))).toBe("too-long");
  });

  it("requires a leading letter, so the address reads like an address", () => {
    expect(usernameProblem("1max")).toBe("must-start-with-letter");
    expect(usernameProblem("_max")).toBe("must-start-with-letter");
    expect(usernameProblem("max1")).toBeNull();
  });

  it("rejects handles that would read as an operator of this service", () => {
    // These become the local part of a real-looking address, which is exactly
    // the misreading worth refusing.
    for (const handle of ["admin", "administrator", "postmaster", "support", "security", "root"]) {
      expect(usernameProblem(handle), handle).toBe("reserved");
    }
  });

  it("reports an empty handle distinctly from a bad one", () => {
    expect(usernameProblem("")).toBe("empty");
    expect(usernameProblem("   ")).toBe("empty");
  });

  it("does not silently strip characters out of a handle", () => {
    // "ma x" and "maxx" must not become the same account. Deleting the space
    // would sign a player into somebody else's lap times without saying so.
    expect(isValidUsername("ma x")).toBe(false);
    expect(isValidUsername("maxx")).toBe(true);
  });
});

describe("the synthetic address", () => {
  it("maps a handle to this module's own domain", () => {
    expect(syntheticEmailFor("max")).toBe(`max@${ACCOUNT_DOMAIN}`);
    expect(syntheticEmailFor("Max")).toBe(`max@${ACCOUNT_DOMAIN}`);
  });

  it("round-trips a handle back out of it", () => {
    for (const handle of ["max", "hussain04", "lando_norris"]) {
      expect(usernameFromSyntheticEmail(syntheticEmailFor(handle))).toBe(handle);
    }
  });

  it("refuses to read a handle out of somebody else's address", () => {
    // A row or token carrying a REAL email must not be relabelled as a handle,
    // or a player would be shown a stranger's address as their name.
    expect(usernameFromSyntheticEmail("someone@gmail.com")).toBeNull();
    expect(usernameFromSyntheticEmail("not-an-email")).toBeNull();
    expect(usernameFromSyntheticEmail(`max@sub.${ACCOUNT_DOMAIN}`)).toBeNull();
    expect(usernameFromSyntheticEmail(`ad min@${ACCOUNT_DOMAIN}`)).toBeNull();
  });
});

describe("passwords", () => {
  it("asks for more than the known floor, and explains the ceiling", () => {
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
    // bcrypt truncates past 72 bytes, so a longer password is a false promise.
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH))).toBeNull();
    expect(passwordProblem("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe("too-long");
  });

  it("reports an empty password distinctly from a short one", () => {
    expect(passwordProblem("")).toBe("empty");
    expect(passwordProblem("short")).toBe("too-short");
  });
});

describe("decodeJwtClaims", () => {
  it("reads the payload of a well-formed token", () => {
    const token = fakeJwt({ sub: "abc", role: "authenticated" });
    const claims = decodeJwtClaims(token);
    expect(claims?.sub).toBe("abc");
    expect(claims?.role).toBe("authenticated");
  });

  it("returns null rather than throwing on rubbish", () => {
    for (const token of ["", "a", "a.b", "a.b.c.d", "not.a.token", ".."]) {
      expect(decodeJwtClaims(token), token).toBeNull();
    }
  });

  it("handles base64url payloads that need re-padding", () => {
    // Lengths that exercise every padding case, since atob is strict about it.
    for (let n = 1; n < 12; n++) {
      const token = fakeJwt({ sub: "x".repeat(n) });
      expect(decodeJwtClaims(token)?.sub, `n=${n}`).toBe("x".repeat(n));
    }
  });
});

describe("sessionFromAuthResponse", () => {
  const valid = {
    access_token: fakeJwt({ sub: "user-1", exp: 1_800_000_000 }),
    refresh_token: "refresh-1",
    expires_in: 3600,
    user: { id: "user-1", user_metadata: { username: "max" } },
  };

  it("builds a session from a real sign-in response", () => {
    const session = sessionFromAuthResponse(valid, 0);
    expect(session).not.toBeNull();
    expect(session!.userId).toBe("user-1");
    expect(session!.username).toBe("max");
    expect(session!.refreshToken).toBe("refresh-1");
    // Expiry comes from the token's own claim, not from expires_in, so a
    // tampered expires_in cannot extend the session's apparent life.
    expect(session!.expiresAtMs).toBe(1_800_000_000_000);
  });

  it("refuses a half-built session rather than returning a broken one", () => {
    // A session with no token, or with a token carrying no subject, would
    // render as signed in and then fail every privileged write.
    expect(sessionFromAuthResponse(null, 0)).toBeNull();
    expect(sessionFromAuthResponse("nope", 0)).toBeNull();
    expect(sessionFromAuthResponse({}, 0)).toBeNull();
    expect(sessionFromAuthResponse({ access_token: "" }, 0)).toBeNull();
    expect(sessionFromAuthResponse({ access_token: fakeJwt({}) }, 0)).toBeNull();
  });

  it("falls back to the address when user_metadata has no usable handle", () => {
    const session = sessionFromAuthResponse(
      { ...valid, user: { id: "user-1", user_metadata: {} }, email: `max@${ACCOUNT_DOMAIN}` },
      0
    );
    expect(session?.username).toBe("max");
  });

  it("leaves the handle empty rather than inventing one", () => {
    // A real email login must not be shown as a handle. Empty means the UI
    // asks again, which is honest; a fabricated name would not be.
    const session = sessionFromAuthResponse(
      { ...valid, user: { id: "u", user_metadata: {} }, email: "someone@gmail.com" },
      0
    );
    expect(session?.username).toBe("");
  });

  it("falls back to expires_in when the token carries no exp", () => {
    const session = sessionFromAuthResponse(
      { ...valid, access_token: fakeJwt({ sub: "user-1" }), expires_in: 900 },
      1_000_000
    );
    expect(session?.expiresAtMs).toBe(1_000_000 + 900_000);
  });
});

describe("sessionNeedsRefresh", () => {
  const base = {
    accessToken: "t",
    refreshToken: "r",
    userId: "u",
    username: "max",
    expiresAtMs: 1_000_000,
  };

  it("asks for a refresh before the token can expire mid-request", () => {
    expect(sessionNeedsRefresh(base, 900_000)).toBe(false);
    expect(sessionNeedsRefresh(base, 940_000)).toBe(true);
    expect(sessionNeedsRefresh(base, 1_000_000)).toBe(true);
  });
});

/** A fetch stand-in that records calls and replies with a fixed response. */
function stubFetch(
  status: number,
  body: unknown,
  onCall?: (url: string, init: RequestInit) => void
) {
  const state = { calls: 0, bodies: [] as unknown[] };
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    state.calls++;
    state.bodies.push(JSON.parse(String(init.body ?? "{}")));
    onCall?.(String(input), init);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  // A fake project, so these exercise the real request path rather than the
  // "this build has no project" branch every one of them would otherwise take.
  const config = { url: "https://project.supabase.co", key: "pk-test" };
  return {
    fetchImpl,
    ...state,
    transport: { fetchImpl, config } as AuthTransport,
    config,
  };
}

const SIGNED_IN = {
  access_token: fakeJwt({ sub: "user-1", exp: 1_800_000_000 }),
  refresh_token: "refresh-1",
  user: { id: "user-1", user_metadata: { username: "max" } },
};

describe("signUp", () => {
  it("sends the synthetic address, never the handle as an email", async () => {
    const stub = stubFetch(200, SIGNED_IN);
    const result = await signUp("max", "Password123", stub.transport);
    expect(result.ok).toBe(true);
    expect(result.session?.username).toBe("max");
    const body = stub.bodies[0] as { email: string; password: string; data: { username: string } };
    expect(body.email).toBe(`max@${ACCOUNT_DOMAIN}`);
    expect(body.password).toBe("Password123");
    // Kept in metadata so it survives into the JWT, which is where the app
    // reads the handle back from.
    expect(body.data.username).toBe("max");
  });

  it("rejects a bad handle or password before making a request", async () => {
    const stub = stubFetch(200, SIGNED_IN);
    expect((await signUp("a", "Password123", stub.transport)).code).toBe("invalid-username");
    expect((await signUp("max", "short", stub.transport)).code).toBe("invalid-password");
    expect(stub.calls).toBe(0);
  });

  it("reports a taken handle", async () => {
    const stub = stubFetch(422, { error_code: "user_already_exists" });
    const result = await signUp("max", "Password123", stub.transport);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("username-taken");
  });

  it("reports rate limiting distinctly from a bad password", async () => {
    const limited = stubFetch(429, { error_code: "over_email_send_rate_limit" });
    expect((await signUp("max", "Password123", limited.transport)).code).toBe("rate-limited");
    const http429 = stubFetch(429, {});
    expect((await signUp("max", "Password123", http429.transport)).code).toBe("rate-limited");
  });

  it("says so plainly when the response is 2xx but carries no session", async () => {
    // This is what an account awaiting email confirmation looks like. Reporting
    // it as a generic failure would read as "the server is broken".
    const stub = stubFetch(200, { id: "pending", confirmation_sent_at: "2026-01-01" });
    const result = await signUp("max", "Password123", stub.transport);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/confirmation/i);
  });

  it("never echoes the password back in a message", async () => {
    const stub = stubFetch(500, { msg: "boom" });
    const result = await signUp("max", "Password123", stub.transport);
    expect(result.message).not.toContain("Password123");
  });
});

describe("signIn", () => {
  it("signs in with the synthetic address", async () => {
    const stub = stubFetch(200, SIGNED_IN);
    const result = await signIn("max", "Password123", stub.transport);
    expect(result.ok).toBe(true);
    expect((stub.bodies[0] as { email: string }).email).toBe(`max@${ACCOUNT_DOMAIN}`);
  });

  it("gives the same answer for a wrong password and an unknown handle", async () => {
    // GoTrue already returns one error for both. Preserving that is the point:
    // a sign-in form that distinguishes them is a free account enumerator.
    const stub = stubFetch(400, { error_code: "invalid_credentials" });
    const result = await signIn("max", "WrongPassword1", stub.transport);
    expect(result.code).toBe("invalid-credentials");
    expect(result.message).toBe("That handle and password do not match.");
  });

  it("resolves rather than rejecting when the network is gone", async () => {
    const transport: AuthTransport = {
      fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      config: { url: "https://project.supabase.co", key: "pk-test" },
    };
    const result = await signIn("max", "Password123", transport);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("network");
    expect(result.session).toBeNull();
  });

  it("resolves rather than rejecting when fetch is missing entirely", async () => {
    const result = await signIn("max", "Password123", {
      fetchImpl: undefined as unknown as typeof fetch,
      config: { url: "https://project.supabase.co", key: "pk-test" },
    });
    // Either it never reaches the network, or it reports it could not. What
    // must not happen is a throw reaching the caller.
    expect(result.ok).toBe(false);
    expect(result.session).toBeNull();
  });

  it("reports an unconfigured build as unconfigured, not as a bad password", async () => {
    // A clone with no project must not tell a player their handle is wrong.
    const result = await signIn("max", "Password123", { config: null });
    expect(result.code).toBe("not-configured");
    expect(result.message).toMatch(/unavailable/i);
  });
});

describe("refreshSession", () => {
  it("keeps the old refresh token when the response omits one", async () => {
    // The new access token was minted FROM the old refresh token, so it is
    // still the live one. Dropping it would sign the player out on the next
    // refresh.
    const stub = stubFetch(200, {
      access_token: fakeJwt({ sub: "user-1", exp: 1_900_000_000 }),
    });
    const result = await refreshSession(
      {
        accessToken: "old",
        refreshToken: "refresh-1",
        expiresAtMs: 0,
        userId: "user-1",
        username: "max",
      },
      stub.transport
    );
    expect(result.ok).toBe(true);
    expect(result.session?.refreshToken).toBe("refresh-1");
    expect(result.session?.accessToken).not.toBe("old");
  });

  it("refuses rather than throwing when there is nothing to refresh with", async () => {
    const result = await refreshSession(
      {
        accessToken: "old",
        refreshToken: "",
        expiresAtMs: 0,
        userId: "user-1",
        username: "max",
      },
      { config: { url: "https://project.supabase.co", key: "pk-test" } }
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid-credentials");
  });
});

describe("signOut", () => {
  it("bears the session token, so the right session ends", async () => {
    let seen = "";
    const stub = stubFetch(204, {}, (_url, init) => {
      seen = String((init.headers as Record<string, string>).Authorization);
    });
    const ok = await signOut(
      { accessToken: "user-jwt", refreshToken: "r", expiresAtMs: 0, userId: "u", username: "max" },
      stub.transport
    );
    expect(ok).toBe(true);
    expect(seen).toBe("Bearer user-jwt");
  });

  it("resolves false when the network is gone", async () => {
    const transport: AuthTransport = {
      fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      config: { url: "https://project.supabase.co", key: "pk-test" },
    };
    await expect(
      signOut({ accessToken: "t", refreshToken: "r", expiresAtMs: 0, userId: "u", username: "x" }, transport)
    ).resolves.toBe(false);
  });
});

describe("session storage", () => {
  function memoryStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
    };
  }

  const session = {
    accessToken: "jwt",
    refreshToken: "refresh",
    expiresAtMs: 2_000_000_000_000,
    userId: "user-1",
    username: "max",
  };

  it("round-trips a session", () => {
    const storage = memoryStorage();
    expect(loadAccountSession(storage, 0)).toBeNull();
    saveAccountSession(session, storage);
    expect(loadAccountSession(storage, 0)).toEqual(session);
  });

  it("discards and clears a stored value that does not parse", () => {
    for (const raw of ["not json", "{}", '{"accessToken":""}', '{"userId":"u"}', "[]"]) {
      const storage = memoryStorage({ "lift-and-coast.account-session.v1": raw });
      expect(loadAccountSession(storage, 0), raw).toBeNull();
      // Cleared, so a broken value is not re-read on every render.
      expect(storage.map.has("lift-and-coast.account-session.v1"), raw).toBe(false);
    }
  });

  it("keeps an expired session only while it can still be refreshed", () => {
    // A refreshable session is recoverable: the next submit refreshes it. One
    // with no refresh token is not, and showing a signed-in header whose every
    // action silently fails is worse than asking again.
    const storage = memoryStorage();
    saveAccountSession({ ...session, expiresAtMs: 1000 }, storage);
    expect(loadAccountSession(storage, 2000)).not.toBeNull();
    storage.map.clear();
    saveAccountSession({ ...session, expiresAtMs: 1000, refreshToken: "" }, storage);
    expect(loadAccountSession(storage, 2000)).toBeNull();
  });

  it("never stores a password, because there is nowhere in this shape to put one", () => {
    const storage = memoryStorage();
    saveAccountSession(session, storage);
    const raw = storage.map.get("lift-and-coast.account-session.v1") ?? "";
    expect(raw).not.toMatch(/password|pass/i);
  });

  it("survives storage that throws, as private browsing does", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadAccountSession(hostile, 0)).toBeNull();
    expect(() => saveAccountSession(session, hostile)).not.toThrow();
    expect(() => clearAccountSession(hostile)).not.toThrow();
  });

  it("is a no-op with no storage at all", () => {
    expect(loadAccountSession(null)).toBeNull();
    expect(() => saveAccountSession(session, null)).not.toThrow();
    expect(() => clearAccountSession(null)).not.toThrow();
  });
});

describe("submitting a lap as a signed-in player", () => {
  const submission = {
    trackId: "monza",
    lapMs: 95_000,
    driverCode: "MAX",
    teamId: "red-bull",
    compound: "soft" as const,
  };
  const config = { url: "https://example.supabase.co", publishableKey: "pk" };

  it("sends the account fields and the player JWT when signed in", async () => {
    let body: Record<string, unknown> = {};
    let auth = "";
    const ok = await submitLap(
      config,
      { ...submission, userId: "user-1", playerName: "max" },
      "user-1",
      TRACK_IDS,
      {
        fetchImpl: (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
          body = JSON.parse(String(init.body));
          auth = String((init.headers as Record<string, string>).Authorization);
          return { ok: true, status: 201, json: async () => ({}) } as Response;
        }) as unknown as typeof fetch,
      },
      "user-jwt"
    );
    expect(ok).toBe(true);
    expect(body.user_id).toBe("user-1");
    expect(body.player_name).toBe("max");
    // The player's token, not the publishable key: that is what makes PostgREST
    // set auth.uid() for the policy to check.
    expect(auth).toBe("Bearer user-jwt");
  });

  it("sends exactly the old anonymous request when there is no account", async () => {
    // An unconfigured build and a player who never signed in must both keep
    // working, byte for byte.
    let body: Record<string, unknown> = {};
    let auth = "";
    const ok = await submitLap(
      config,
      submission,
      "client-1",
      TRACK_IDS,
      {
        fetchImpl: (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
          body = JSON.parse(String(init.body));
          auth = String((init.headers as Record<string, string>).Authorization);
          return { ok: true, status: 201, json: async () => ({}) } as Response;
        }) as unknown as typeof fetch,
      }
    );
    expect(ok).toBe(true);
    expect("user_id" in body).toBe(false);
    expect("player_name" in body).toBe(false);
    expect(auth).toBe("Bearer pk");
  });
});

describe("board rows and my-times", () => {
  it("reads the account columns, defaulting them to null for old rows", () => {
    const anonymous = rowToEntry({
      track_id: "monza",
      lap_ms: 95_000,
      driver_code: "VER",
      team_id: "red-bull",
      compound: "soft",
      created_at: "2026-09-28T00:00:00.000Z",
    });
    expect(anonymous?.playerName).toBeNull();
    expect(anonymous?.userId).toBeNull();

    const signed = rowToEntry({
      track_id: "monza",
      lap_ms: 94_000,
      driver_code: "MAX",
      team_id: "red-bull",
      compound: "soft",
      created_at: "2026-09-28T00:00:00.000Z",
      player_name: "max",
      user_id: "user-1",
    });
    expect(signed?.playerName).toBe("max");
    expect(signed?.userId).toBe("user-1");
  });

  it("treats an empty player_name as absent", () => {
    const row = rowToEntry({
      track_id: "monza",
      lap_ms: 95_000,
      driver_code: "VER",
      team_id: "red-bull",
      compound: "soft",
      created_at: "2026-09-28T00:00:00.000Z",
      player_name: "",
    });
    expect(row?.playerName).toBeNull();
  });

  it("filters my-times by the player, bounded", () => {
    const query = buildMyTimesQuery("user-1", 30);
    expect(query).toContain("user_id=eq.user-1");
    expect(query).toContain("order=lap_ms.asc");
    // Bounded, because it is still a client-driven query on a public table.
    expect(buildMyTimesQuery("u", 100_000)).toContain("limit=200");
    expect(buildMyTimesQuery("u", 0)).toContain("limit=1");
  });
});

describe("accountsConfigured", () => {
  it("reads the same env the leaderboard does, and never throws", () => {
    expect(typeof accountsConfigured()).toBe("boolean");
  });
});
