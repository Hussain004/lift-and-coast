import { describe, expect, it } from "vitest";
import {
  TIME_ATTACK_COMPOUND,
  isSaveableTimeAttackLap,
  submitTimeAttackLap,
  timeAttackSubmission,
} from "../lib/race/timeAttackBoard";
import { buildRaceUrl, parseTimeAttack, parseSessionMode, parseQualifyingFormat } from "../lib/race/sessionSetup";
import { TRACKS } from "../lib/tracks/registry";
import { MIN_LAP_SECONDS } from "../lib/race/lapTimer";
import type { AccountSession } from "../lib/race/accounts";

/**
 * The time attack decides what gets written to a PUBLIC board, so these lean on
 * two things: that a lap is only ever saved when it is genuinely an
 * improvement, and that an anonymous save sends exactly the request that has
 * always worked.
 *
 * What is NOT here is the lap timing itself. That is the race's own
 * `createLapTimer` and `isQualifyingLapValid`, tested in tests/lapTimer.test.ts
 * and tests/qualifying.test.ts, and driven end to end on real circuits in
 * tests/timeAttackIntegration.test.ts. This file covers only the save.
 */

const TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));
const SESSION: AccountSession = {
  accessToken: "user-jwt",
  refreshToken: "refresh",
  expiresAtMs: 2_000_000_000_000,
  userId: "user-1",
  username: "max",
};

describe("isSaveableTimeAttackLap", () => {
  it("saves the first lap, and every later improvement", () => {
    expect(isSaveableTimeAttackLap(null, 95_000)).toBe(true);
    expect(isSaveableTimeAttackLap(95_000, 94_000)).toBe(true);
    expect(isSaveableTimeAttackLap(95_000, 80_500)).toBe(true);
  });

  it("saves neither a slower lap nor a matched one", () => {
    // The matched case matters: re-posting a time the player already has would
    // fill the public table with duplicates and burn the write rate limit.
    expect(isSaveableTimeAttackLap(94_000, 95_000)).toBe(false);
    expect(isSaveableTimeAttackLap(94_000, 94_000)).toBe(false);
  });

  it("refuses a time that is not a lap", () => {
    // Below the circuit-independent floor: a car shuffling over the line, which
    // is the same reason the race's own lap timer will not bank it.
    expect(isSaveableTimeAttackLap(null, (MIN_LAP_SECONDS - 1) * 1000)).toBe(false);
    expect(isSaveableTimeAttackLap(null, 0)).toBe(false);
    expect(isSaveableTimeAttackLap(null, -90_000)).toBe(false);
    expect(isSaveableTimeAttackLap(null, Number.NaN)).toBe(false);
    expect(isSaveableTimeAttackLap(null, Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("accepts a lap exactly on the floor", () => {
    // The boundary is inclusive, and pinned because an off-by-one here would
    // silently drop the fastest possible lap on a very short circuit.
    expect(isSaveableTimeAttackLap(null, MIN_LAP_SECONDS * 1000)).toBe(true);
  });
});

describe("timeAttackSubmission", () => {
  const base = {
    trackId: "monza",
    lapMs: 88_123.6,
    driverCode: "VER",
    teamId: "red-bull",
    session: null,
    knownTrackIds: TRACK_IDS,
  };

  it("files an anonymous lap with no account fields at all", () => {
    const submission = timeAttackSubmission(base);
    expect(submission).toEqual({
      trackId: "monza",
      // Rounded, because the column is an integer of milliseconds and a
      // fractional value would be refused by the CHECK.
      lapMs: 88_124,
      driverCode: "VER",
      teamId: "red-bull",
      compound: TIME_ATTACK_COMPOUND,
    });
    // Not present-and-null: absent, so the request is byte-for-byte the one
    // that has always worked for a player who never signed in.
    expect(submission && "userId" in submission).toBe(false);
    expect(submission && "playerName" in submission).toBe(false);
  });

  it("attaches the account to a signed-in lap", () => {
    const submission = timeAttackSubmission({ ...base, session: SESSION });
    expect(submission?.userId).toBe("user-1");
    expect(submission?.playerName).toBe("max");
  });

  it("omits the handle rather than sending an empty one", () => {
    // A session with no readable handle is a real case (see
    // sessionFromAuthResponse), and an empty player_name would render as a
    // blank name on the public board instead of falling back to the code.
    const submission = timeAttackSubmission({
      ...base,
      session: { ...SESSION, username: "" },
    });
    expect(submission).not.toBeNull();
    expect(submission && "playerName" in submission).toBe(false);
    // The row is still claimed: the account is what identifies it, the handle
    // is only ever a label.
    expect(submission?.userId).toBe("user-1");
  });

  it("refuses a row the board would reject anyway", () => {
    // The same gate the landing page's own submission used, so the two paths
    // cannot drift: an unknown circuit, a code the CHECK will not take, or a
    // team id that is out of range is refused here rather than at the database.
    expect(timeAttackSubmission({ ...base, trackId: "not-a-circuit" })).toBeNull();
    expect(timeAttackSubmission({ ...base, driverCode: "V" })).toBeNull();
    expect(timeAttackSubmission({ ...base, driverCode: "VERSTA" })).toBeNull();
    expect(timeAttackSubmission({ ...base, teamId: "" })).toBeNull();
    expect(timeAttackSubmission({ ...base, lapMs: 0 })).toBeNull();
    expect(timeAttackSubmission({ ...base, lapMs: 1.5 })).toBeNull();
  });
});

describe("submitTimeAttackLap", () => {
  const options = {
    trackId: "monza",
    lapMs: 88_123,
    driverCode: "VER",
    teamId: "red-bull",
    knownTrackIds: TRACK_IDS,
  };

  it("sends the account id and the player token when signed in", async () => {
    let body: Record<string, unknown> = {};
    let auth = "";
    await submitTimeAttackLap({
      ...options,
      session: SESSION,
      clientId: "device-1",
      // A fake project, so this exercises the real request path rather than
      // the "this build has no board" branch every one would otherwise take.
      config: { url: "https://project.supabase.co", publishableKey: "pk-test" },
      transport: {
        fetchImpl: (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
          body = JSON.parse(String(init.body));
          auth = String((init.headers as Record<string, string>).Authorization);
          return { ok: true, status: 201, json: async () => ({}) } as Response;
        }) as unknown as typeof fetch,
      },
    });
    expect(body.user_id).toBe("user-1");
    expect(body.player_name).toBe("max");
    // The player's own JWT, not the publishable key: that is what makes
    // PostgREST set auth.uid() for the insert policy to check.
    expect(auth).toBe("Bearer user-jwt");
  });

  it("sends the old anonymous request when there is no account", async () => {
    // Byte-for-byte the request that has always worked for a player who never
    // signed in: no account fields, and the publishable key as the bearer.
    let body: Record<string, unknown> = {};
    let auth = "";
    await submitTimeAttackLap({
      ...options,
      session: null,
      clientId: "device-1",
      config: { url: "https://project.supabase.co", publishableKey: "pk-test" },
      transport: {
        fetchImpl: (async (_u: RequestInfo | URL, init: RequestInit = {}) => {
          body = JSON.parse(String(init.body));
          auth = String((init.headers as Record<string, string>).Authorization);
          return { ok: true, status: 201, json: async () => ({}) } as Response;
        }) as unknown as typeof fetch,
      },
    });
    expect("user_id" in body).toBe(false);
    expect("player_name" in body).toBe(false);
    expect(auth).toBe("Bearer pk-test");
  });

  it("resolves false rather than rejecting when the build has no board", async () => {
    // A clone with no project must not take a lap down with it, and must not
    // be told the lap was refused for a reason the player cannot act on.
    await expect(
      submitTimeAttackLap({ ...options, session: null, config: null })
    ).resolves.toBe(false);
  });
});

describe("the ?ta=1 flag", () => {
  it("is only set when asked for, and round-trips", () => {
    const url = buildRaceUrl({ mode: "qualifying", track: "monza", timeAttack: true });
    expect(url).toContain("ta=1");
    expect(parseTimeAttack(new URL(url, "http://x").searchParams.get("ta"))).toBe(true);
  });

  it("is absent by default, so every existing link is unchanged", () => {
    const url = buildRaceUrl({ mode: "race", track: "monza" });
    expect(url).not.toContain("ta=");
    expect(parseTimeAttack(null)).toBe(false);
  });

  it("ignores a stray or zero value rather than half-enabling the session", () => {
    // A half-applied time attack would be worse than either state: a session
    // that never ends but also never saves.
    expect(parseTimeAttack("")).toBe(false);
    expect(parseTimeAttack("0")).toBe(false);
    expect(parseTimeAttack("yes")).toBe(false);
    expect(parseTimeAttack("true")).toBe(true);
    expect(parseTimeAttack("1")).toBe(true);
  });

  it("leaves a normal qualifying link a normal qualifying link", () => {
    // The flag is additive. It must not have changed what ?mode= and ?qformat=
    // mean for anyone not using it.
    const url = buildRaceUrl({ mode: "qualifying", track: "spa", qformat: "oneshot" });
    const params = new URL(url, "http://x").searchParams;
    expect(parseSessionMode(params.get("mode"))).toBe("qualifying");
    expect(parseQualifyingFormat(params.get("qformat"))).toBe("oneshot");
    expect(parseTimeAttack(params.get("ta"))).toBe(false);
  });
});
