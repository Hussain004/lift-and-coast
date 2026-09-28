import { describe, expect, it } from "vitest";
import {
  LAP_MAX_MS,
  LAP_MIN_MS,
  formatLapTime,
  formatLapTimeFromWholeMs,
  generateUuid,
  bestPerPlayer,
  isSubmittableLap,
  isUuid,
  rankForLap,
  resolveClientId,
  sortLeaderboard,
  type LapSubmission,
  type LeaderboardEntry,
} from "../lib/race/leaderboard";
import {
  buildLeaderboardQuery,
  fetchLeaderboard,
  leaderboardConfigFromEnv,
  rowToEntry,
  submitLap,
  type LeaderboardConfig,
} from "../lib/race/leaderboardClient";
import { TRACKS } from "../lib/tracks/registry";

const TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));

function submission(over: Partial<LapSubmission> = {}): LapSubmission {
  return {
    trackId: "monza",
    lapMs: 95_000,
    driverCode: "VER",
    teamId: "red-bull",
    compound: "soft",
    ...over,
  };
}

function entry(over: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
  return {
    trackId: "monza",
    lapMs: 95_000,
    driverCode: "VER",
    teamId: "red-bull",
    compound: "soft",
    createdAt: "2026-09-28T00:00:00.000Z",
    // Anonymous by default, which is what the board held before accounts
    // existed; the account tests set these explicitly.
    playerName: null,
    userId: null,
    // The anonymous per-browser id, which the board has always carried and
    // which is the only identity an unsigned row has.
    clientId: "00000000-0000-4000-8000-000000000000",
    ...over,
  };
}

/** A fetch stand-in that records the call and replies with `status`/`body`. */
function stubFetch(
  status: number,
  body: unknown,
  onCall?: (url: string, init: RequestInit) => void
): { fetchImpl: typeof fetch; calls: number } {
  const state = { fetchImpl: null as unknown as typeof fetch, calls: 0 };
  state.fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    state.calls++;
    onCall?.(String(input), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return state;
}

describe("isSubmittableLap", () => {
  it("accepts a plausible lap", () => {
    expect(isSubmittableLap(submission(), TRACK_IDS)).toBe(true);
  });

  it("rejects times outside the plausibility band", () => {
    expect(isSubmittableLap(submission({ lapMs: LAP_MIN_MS - 1 }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ lapMs: LAP_MAX_MS + 1 }), TRACK_IDS)).toBe(false);
    // The band edges themselves are allowed.
    expect(isSubmittableLap(submission({ lapMs: LAP_MIN_MS }), TRACK_IDS)).toBe(true);
    expect(isSubmittableLap(submission({ lapMs: LAP_MAX_MS }), TRACK_IDS)).toBe(true);
  });

  it("rejects non-integer and non-finite times", () => {
    expect(isSubmittableLap(submission({ lapMs: 95_000.5 }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ lapMs: Number.NaN }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ lapMs: Number.POSITIVE_INFINITY }), TRACK_IDS)).toBe(false);
  });

  it("rejects an unknown circuit, compound or malformed identity", () => {
    expect(isSubmittableLap(submission({ trackId: "nurburgring-oval" }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ compound: "ultrasoft" }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ driverCode: "V" }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ driverCode: "VERIFY" }), TRACK_IDS)).toBe(false);
    expect(isSubmittableLap(submission({ teamId: "" }), TRACK_IDS)).toBe(false);
  });
});

describe("sortLeaderboard", () => {
  it("orders fastest first, and earlier first on a tie", () => {
    const sorted = sortLeaderboard([
      entry({ lapMs: 96_000, createdAt: "2026-09-28T00:00:00.000Z" }),
      entry({ lapMs: 94_000, createdAt: "2026-09-28T00:00:00.000Z" }),
      entry({ lapMs: 94_000, createdAt: "2026-09-27T00:00:00.000Z" }),
    ]);
    expect(sorted.map((e) => e.lapMs)).toEqual([94_000, 94_000, 96_000]);
    // The tie-break put the EARLIER submission first.
    expect(sorted[0].createdAt).toBe("2026-09-27T00:00:00.000Z");
  });

  it("does not mutate its input", () => {
    const input = [entry({ lapMs: 96_000 }), entry({ lapMs: 94_000 })];
    const copy = [...input];
    sortLeaderboard(input);
    expect(input).toEqual(copy);
  });
});

describe("formatLapTime", () => {
  it("renders minutes, seconds and milliseconds at a fixed width", () => {
    expect(formatLapTime(83_456)).toBe("1:23.456");
    expect(formatLapTime(60_000)).toBe("1:00.000");
    expect(formatLapTime(95_000)).toBe("1:35.000");
    // A sub-minute lap still pads the seconds to three decimals.
    expect(formatLapTime(9_500)).toBe("0:09.500");
  });

  it("rejects values that are not a real lap time", () => {
    expect(formatLapTime(0)).toBeNull();
    expect(formatLapTime(-1)).toBeNull();
    expect(formatLapTime(Number.NaN)).toBeNull();
    expect(formatLapTimeFromWholeMs(83_456.5)).toBeNull();
  });
});

describe("resolveClientId", () => {
  function fakeStorage(initial?: string) {
    const store = new Map<string, string>();
    if (initial !== undefined) store.set("lift-and-coast.client-id.v1", initial);
    return {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
  }

  it("generates and persists an id on first use", () => {
    const storage = fakeStorage();
    const first = resolveClientId(storage)!;
    expect(isUuid(first)).toBe(true);
    expect(storage.getItem("lift-and-coast.client-id.v1")).toBe(first);
  });

  it("is stable across calls", () => {
    const storage = fakeStorage();
    expect(resolveClientId(storage)).toBe(resolveClientId(storage));
  });

  it("replaces a corrupt stored value rather than trusting it", () => {
    const storage = fakeStorage("not-a-uuid");
    const id = resolveClientId(storage)!;
    expect(isUuid(id)).toBe(true);
    expect(storage.getItem("lift-and-coast.client-id.v1")).toBe(id);
  });

  it("returns null when storage is unavailable", () => {
    expect(resolveClientId(null)).toBeNull();
  });
});

describe("generateUuid / isUuid", () => {
  it("produces well-formed v4 uuids", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateUuid();
      expect(isUuid(id)).toBe(true);
      // Version 4, variant 1.
      expect(id[14]).toBe("4");
      expect("89ab".includes(id[19])).toBe(true);
    }
  });

  it("is not trivially repetitive", () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateUuid()));
    expect(ids.size).toBe(200);
  });

  it("rejects malformed values", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("1111")).toBe(false);
    expect(isUuid("11111111-1111-4111-8111-11111111111")).toBe(false);
    expect(isUuid("zzzzzzzz-1111-4111-8111-111111111111")).toBe(false);
  });
});

describe("rankForLap", () => {
  const board = [entry({ lapMs: 92_000 }), entry({ lapMs: 94_000 }), entry({ lapMs: 96_000 })];

  it("ranks faster than everything as 1", () => {
    expect(rankForLap(board, 90_000)).toBe(1);
  });

  it("ranks between entries correctly", () => {
    expect(rankForLap(board, 93_000)).toBe(2);
    expect(rankForLap(board, 95_000)).toBe(3);
  });

  it("is null when the lap would not make the table", () => {
    expect(rankForLap(board, 99_000)).toBeNull();
  });

  it("is null for an empty board or a bad time", () => {
    expect(rankForLap([], 90_000)).toBeNull();
    expect(rankForLap(board, Number.NaN)).toBeNull();
  });
});

describe("leaderboardConfigFromEnv", () => {
  it("reads both values and trims a trailing slash", () => {
    const config = leaderboardConfigFromEnv({
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co/",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
    });
    expect(config).toEqual({ url: "https://example.supabase.co", publishableKey: "sb_publishable_x" });
  });

  it("is null when either value is missing, so a fresh clone just has no board", () => {
    expect(leaderboardConfigFromEnv({})).toBeNull();
    expect(leaderboardConfigFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://x.co" })).toBeNull();
    expect(
      leaderboardConfigFromEnv({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" })
    ).toBeNull();
  });
});

describe("rowToEntry", () => {
  it("maps a database row", () => {
    expect(
      rowToEntry({
        track_id: "monza",
        lap_ms: 95_000,
        driver_code: "VER",
        team_id: "red-bull",
        compound: "soft",
        created_at: "2026-09-28T00:00:00.000Z",
      })
    ).toEqual({
      trackId: "monza",
      lapMs: 95_000,
      driverCode: "VER",
      teamId: "red-bull",
      compound: "soft",
      createdAt: "2026-09-28T00:00:00.000Z",
      // A row from before accounts existed has neither, and reads as anonymous
      // rather than as a row with missing data.
      playerName: null,
      userId: null,
      clientId: null,
    });
  });

  it("drops rows it cannot read rather than rendering garbage", () => {
    expect(rowToEntry(null)).toBeNull();
    expect(rowToEntry("nope")).toBeNull();
    expect(rowToEntry({ lap_ms: 95_000 })).toBeNull();
    expect(rowToEntry({ track_id: "monza", lap_ms: "fast" })).toBeNull();
  });
});

describe("buildLeaderboardQuery", () => {
  it("asks for the fastest rows on one track and bounds the limit", () => {
    const query = buildLeaderboardQuery("monza", 10);
    expect(query).toContain("track_id=eq.monza");
    expect(query).toContain("order=lap_ms.asc");
    expect(query).toContain("limit=10");
    expect(buildLeaderboardQuery("monza", 0)).toContain("limit=1");
    expect(buildLeaderboardQuery("monza", 9999)).toContain("limit=100");
  });
});

describe("fetchLeaderboard", () => {
  const config: LeaderboardConfig = { url: "https://x.supabase.co", publishableKey: "k" };

  it("returns a sorted list on success", async () => {
    const stub = stubFetch(200, [
      { track_id: "monza", lap_ms: 96_000, driver_code: "A", team_id: "t", compound: "soft", created_at: "2026-09-28T00:00:00Z" },
      { track_id: "monza", lap_ms: 94_000, driver_code: "B", team_id: "t", compound: "soft", created_at: "2026-09-28T00:00:00Z" },
    ]);
    const board = await fetchLeaderboard(config, "monza", 5, { fetchImpl: stub.fetchImpl });
    expect(board.map((e) => e.lapMs)).toEqual([94_000, 96_000]);
  });

  it("sends the publishable key and never a secret", async () => {
    let seen: Record<string, string> = {};
    const stub = stubFetch(200, [], (_url, init) => {
      seen = (init.headers ?? {}) as Record<string, string>;
    });
    await fetchLeaderboard(config, "monza", 5, { fetchImpl: stub.fetchImpl });
    expect(seen.apikey).toBe("k");
    expect(seen.Authorization).toBe("Bearer k");
    expect(JSON.stringify(seen)).not.toMatch(/service_role|secret/i);
  });

  it("degrades to an empty list rather than throwing", async () => {
    // This is the whole point of the module: a leaderboard failure must never
    // be able to take the game down with it.
    expect(await fetchLeaderboard(config, "monza", 5, { fetchImpl: stubFetch(500, {}).fetchImpl })).toEqual([]);
    expect(await fetchLeaderboard(config, "monza", 5, { fetchImpl: stubFetch(401, {}).fetchImpl })).toEqual([]);
    expect(
      await fetchLeaderboard(config, "monza", 5, {
        fetchImpl: (() => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      })
    ).toEqual([]);
    expect(
      await fetchLeaderboard(config, "monza", 5, {
        fetchImpl: (async () => {
          throw new Error("aborted");
        }) as unknown as typeof fetch,
      })
    ).toEqual([]);
  });

  it("skips unreadable rows but keeps the good ones", async () => {
    const stub = stubFetch(200, [
      { track_id: "monza", lap_ms: 96_000, driver_code: "A", team_id: "t", compound: "soft" },
      { nonsense: true },
      { track_id: "monza", lap_ms: 94_000, driver_code: "B", team_id: "t", compound: "soft" },
    ]);
    const board = await fetchLeaderboard(config, "monza", 5, { fetchImpl: stub.fetchImpl });
    expect(board).toHaveLength(2);
  });

  it("is a no-op with no config, and never touches the network", async () => {
    const stub = stubFetch(200, []);
    expect(await fetchLeaderboard(null, "monza", 5, { fetchImpl: stub.fetchImpl })).toEqual([]);
    expect(stub.calls).toBe(0);
  });
});

describe("submitLap", () => {
  const config: LeaderboardConfig = { url: "https://x.supabase.co", publishableKey: "k" };

  it("posts the row and reports success", async () => {
    let body: Record<string, unknown> = {};
    const stub = stubFetch(201, [], (_url, init) => {
      body = JSON.parse(String(init.body));
    });
    const ok = await submitLap(
      config,
      submission(),
      "11111111-1111-4111-8111-111111111111",
      TRACK_IDS,
      { fetchImpl: stub.fetchImpl }
    );
    expect(ok).toBe(true);
    expect(body).toEqual({
      track_id: "monza",
      lap_ms: 95_000,
      driver_code: "VER",
      team_id: "red-bull",
      compound: "soft",
      client_id: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("refuses an implausible lap without a round trip", async () => {
    const stub = stubFetch(201, []);
    const ok = await submitLap(config, submission({ lapMs: 5 }), "id", TRACK_IDS, {
      fetchImpl: stub.fetchImpl,
    });
    expect(ok).toBe(false);
    expect(stub.calls).toBe(0);
  });

  it("is a no-op with no config or no client id", async () => {
    const stub = stubFetch(201, []);
    expect(
      await submitLap(null, submission(), "id", TRACK_IDS, { fetchImpl: stub.fetchImpl })
    ).toBe(false);
    expect(await submitLap(config, submission(), null, TRACK_IDS, { fetchImpl: stub.fetchImpl })).toBe(
      false
    );
    expect(stub.calls).toBe(0);
  });

  it("reports failure instead of throwing when the server rejects it", async () => {
    const stub = stubFetch(400, { message: "check constraint" });
    expect(
      await submitLap(config, submission(), "id", TRACK_IDS, { fetchImpl: stub.fetchImpl })
    ).toBe(false);
  });
});

describe("one row per player on the board", () => {
  const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const CARA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  it("keeps each player's fastest lap and drops their slower ones", () => {
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE }),
      entry({ lapMs: 207_184, clientId: ALICE }),
      entry({ lapMs: 81_000, clientId: BOB }),
    ];
    const board = bestPerPlayer(rows, 5);
    expect(board.map((e) => e.lapMs)).toEqual([77_100, 81_000]);
  });

  it("does not let one prolific driver crowd out the board", () => {
    // The reported symptom, exactly: one player holding two of the five
    // visible rows used to take two places and push a rival off the board.
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE }),
      entry({ lapMs: 207_184, clientId: ALICE }),
      entry({ lapMs: 88_000, clientId: BOB }),
    ];
    const board = bestPerPlayer(rows, 2);
    expect(board.map((e) => e.lapMs)).toEqual([77_100, 88_000]);
  });

  it("still orders the survivors fastest first", () => {
    const rows = [
      entry({ lapMs: 95_000, clientId: ALICE }),
      entry({ lapMs: 80_000, clientId: BOB }),
      entry({ lapMs: 88_000, clientId: CARA }),
    ];
    expect(bestPerPlayer(rows, 5).map((e) => e.lapMs)).toEqual([80_000, 88_000, 95_000]);
  });

  it("applies the limit to players, not to laps", () => {
    const rows = [
      entry({ lapMs: 80_000, clientId: ALICE }),
      entry({ lapMs: 80_500, clientId: ALICE }),
      entry({ lapMs: 81_000, clientId: BOB }),
      entry({ lapMs: 82_000, clientId: CARA }),
    ];
    expect(bestPerPlayer(rows, 2)).toHaveLength(2);
  });

  it("gives the earlier of two equal laps the row", () => {
    // sortLeaderboard's tie-break, preserved: setting the same time twice is
    // the first setter's row, and the dedupe must not reshuffle that.
    const rows = [
      entry({ lapMs: 80_000, clientId: ALICE, createdAt: "2026-09-28T10:00:00.000Z" }),
      entry({ lapMs: 80_000, clientId: ALICE, createdAt: "2026-09-28T09:00:00.000Z" }),
    ];
    const board = bestPerPlayer(rows, 5);
    expect(board).toHaveLength(1);
    expect(board[0].createdAt).toBe("2026-09-28T09:00:00.000Z");
  });

  it("merges one player's signed-in and anonymous laps from the same browser", () => {
    // A signed-in lap in a browser carries BOTH ids, so the anonymous lap this
    // browser set earlier is the same person. Keying on user_id alone would
    // show these as two rivals of each other.
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE, userId: null, playerName: null }),
      entry({ lapMs: 90_000, clientId: ALICE, userId: "user-alice", playerName: "hussain" }),
    ];
    const board = bestPerPlayer(rows, 5);
    expect(board).toHaveLength(1);
    expect(board[0].lapMs).toBe(77_100);
  });

  it("merges one account's laps across two different browsers", () => {
    // The other direction, which keying on client_id alone gets wrong.
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE, userId: "user-alice" }),
      entry({ lapMs: 84_000, clientId: BOB, userId: "user-alice" }),
    ];
    const board = bestPerPlayer(rows, 5);
    expect(board).toHaveLength(1);
    expect(board[0].clientId).toBe(ALICE);
  });

  it("does NOT merge an unrelated browser's anonymous lap into an account", () => {
    // Nothing links these, and guessing that they are the same person would be
    // inventing an identity the data does not contain.
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE, userId: null, playerName: null }),
      entry({ lapMs: 90_000, clientId: BOB, userId: "user-alice", playerName: "hussain" }),
    ];
    expect(bestPerPlayer(rows, 5)).toHaveLength(2);
  });

  it("merges transitively through a shared id", () => {
    // alice/anonymous -> alice/signed-in -> bob-browser/same account. Each
    // link is one shared id; the group is only correct if the merge composes.
    const rows = [
      entry({ lapMs: 70_000, clientId: ALICE, userId: null }),
      entry({ lapMs: 75_000, clientId: ALICE, userId: "user-alice" }),
      entry({ lapMs: 80_000, clientId: BOB, userId: "user-alice" }),
    ];
    const board = bestPerPlayer(rows, 5);
    expect(board).toHaveLength(1);
    expect(board[0].lapMs).toBe(70_000);
  });

  it("does NOT merge two different anonymous browsers on a shared handle", () => {
    // Handles are self-chosen and unverified, so two browsers typing the same
    // name are two players. Collapsing them would be inventing an identity
    // the data does not contain.
    const rows = [
      entry({ lapMs: 77_100, clientId: ALICE, playerName: "hussain" }),
      entry({ lapMs: 80_000, clientId: BOB, playerName: "hussain" }),
    ];
    expect(bestPerPlayer(rows, 5)).toHaveLength(2);
  });

  it("keeps rows it cannot attribute rather than hiding them", () => {
    // A row with neither id is a data problem somewhere else; dropping it
    // would make a set lap vanish for a reason the player cannot see.
    const rows = [
      entry({ lapMs: 77_100, userId: null, clientId: null }),
      entry({ lapMs: 80_000, userId: null, clientId: null }),
    ];
    expect(bestPerPlayer(rows, 5)).toHaveLength(2);
  });

  it("returns a new array and does not mutate its input", () => {
    const rows = [entry({ lapMs: 80_000, clientId: ALICE }), entry({ lapMs: 70_000, clientId: BOB })];
    const before = rows.map((e) => e.lapMs);
    const board = bestPerPlayer(rows, 5);
    expect(rows.map((e) => e.lapMs)).toEqual(before);
    expect(board).not.toBe(rows);
  });

  it("copes with a zero, negative or junk limit", () => {
    const rows = [entry({ lapMs: 80_000, clientId: ALICE })];
    expect(bestPerPlayer(rows, 0)).toHaveLength(0);
    expect(bestPerPlayer(rows, -5)).toHaveLength(0);
    expect(bestPerPlayer(rows, NaN)).toHaveLength(0);
  });

  it("over-fetches so a crowded slice still fills the board", async () => {
    // The slice has to be deeper than the requested rows, or five rows from
    // two prolific drivers dedupe down to a two-row board.
    const config = { url: "https://example.supabase.co", publishableKey: "pk" };
    const calls: string[] = [];
    const five = [1, 2, 3, 4, 5].map((k) => ({
      track_id: "monza",
      lap_ms: 70_000 + k,
      driver_code: "VER",
      team_id: "ferrari",
      compound: "soft",
      created_at: "2026-09-28T00:00:00.000Z",
      client_id: `client-${k}`,
    }));
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => five } as unknown as Response;
    }) as unknown as typeof fetch;

    const board = await fetchLeaderboard(config, "monza", 5, { fetchImpl });
    expect(board).toHaveLength(5);
    const requested = new URL(calls[0], "https://x").searchParams.get("limit");
    expect(Number(requested)).toBeGreaterThanOrEqual(5);
  });

  it("asks the server for client_id so unsigned rows can be told apart", () => {
    const query = buildLeaderboardQuery("monza", 5);
    expect(query).toContain("client_id");
  });
});
