import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseNetMessage,
  type NetDriverInfo,
  type NetLobbyRow,
  type NetSettings,
} from "../lib/net/protocol";
import {
  MAX_NET_HUMANS,
  allReady,
  canStart,
  createReadyLobbyState,
  hostIsReady,
  lobbyRows,
  lobbySlots,
  membersNotReady,
  readyLobbyReducer,
  setHostDriver,
  type ReadyLobbyState,
} from "../lib/net/lobby";

/**
 * Roadmap 11.14: multiplayer polish - the lobby ready check, per-member
 * latency, the rematch request, safety-car sync and graceful host-left.
 *
 * The protocol guards are the security boundary, so they are tested as a
 * boundary: every new message is checked both ways, because a guard that
 * accepts malformed input is worse than no guard, because it fails open
 * instead of dropping the message.
 */

const driver = (code: string): NetDriverInfo => ({
  code,
  name: `Driver ${code}`,
  teamId: "alpine",
  color: "#ff0000",
});

const settings: NetSettings = { track: "monza", mode: "race", laps: 3, rivals: 4, tod: "day" };

/** A host with two guests, none ready. */
function room(): ReadyLobbyState {
  let state = createReadyLobbyState(true, settings);
  state = readyLobbyReducer(state, { type: "opened", selfId: "host", code: "ABC234" });
  state = setHostDriver(state, driver("VER"));
  state = readyLobbyReducer(state, { type: "member-joined", peerId: "g1", driver: driver("HAM") });
  state = readyLobbyReducer(state, { type: "member-joined", peerId: "g2", driver: driver("LEC") });
  return state;
}

describe("protocol version", () => {
  it("is bumped, so a v2 peer is rejected at hello rather than half-understood", () => {
    // The reason for the bump: an old peer would silently ignore `ready`,
    // `lobby-state` and `rematch`, and a guest stuck in that state would sit
    // at the start line forever with no way to know it was out of date.
    expect(PROTOCOL_VERSION).toBe(3);
    const hello = (version: number) => ({ type: "hello", version, driver: driver("HAM") });
    expect(parseNetMessage(hello(PROTOCOL_VERSION))).not.toBeNull();
    expect(parseNetMessage(hello(2))).toBeNull();
    expect(parseNetMessage(hello(1))).toBeNull();
  });
});

describe("ready message guard", () => {
  it("accepts a bare ready and one carrying a driver", () => {
    expect(parseNetMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseNetMessage({ type: "ready", driver: driver("HAM") })).toEqual({
      type: "ready",
      driver: driver("HAM"),
    });
  });

  it("rejects a malformed driver rather than half-applying the message", () => {
    // The failure this guards against: a guest reports ready with a broken
    // driver and the host marks it ready anyway, then tries to build a car
    // from a half-valid driver.
    expect(parseNetMessage({ type: "ready", driver: { code: "HAM" } })).toBeNull();
    expect(parseNetMessage({ type: "ready", driver: null })).toBeNull();
    expect(parseNetMessage({ type: "ready", driver: "HAM" })).toBeNull();
  });
});

describe("lobby-state guard", () => {
  const row = (over: Partial<NetLobbyRow> = {}): NetLobbyRow => ({
    peerId: "g1",
    driver: driver("HAM"),
    ready: true,
    pingMs: 42,
    ...over,
  });

  it("accepts a well-formed table", () => {
    const msg = { type: "lobby-state", members: [row(), row({ peerId: "g2", ready: false, pingMs: null })] };
    expect(parseNetMessage(msg)).toEqual(msg);
  });

  it("rejects a malformed row, the whole message, never a partial table", () => {
    expect(parseNetMessage({ type: "lobby-state", members: [row({ ready: "yes" as never })] })).toBeNull();
    expect(parseNetMessage({ type: "lobby-state", members: [row({ pingMs: "42" as never })] })).toBeNull();
    expect(parseNetMessage({ type: "lobby-state", members: [row({ driver: null as never })] })).toBeNull();
    expect(parseNetMessage({ type: "lobby-state", members: "all" })).toBeNull();
    expect(parseNetMessage({ type: "lobby-state" })).toBeNull();
    // NaN is the interesting ping case: a peer that has measured nothing must
    // send null, and an infinite latency must not reach the panel either.
    expect(parseNetMessage({ type: "lobby-state", members: [row({ pingMs: NaN })] })).toBeNull();
    expect(parseNetMessage({ type: "lobby-state", members: [row({ pingMs: Infinity })] })).toBeNull();
  });
});

describe("ping and pong guards", () => {
  it("accepts a matching pair and echoes the token", () => {
    const ping = { type: "ping", atMs: 1000, token: 7 };
    expect(parseNetMessage(ping)).toEqual(ping);
    const pong = { type: "pong", atMs: 1000, token: 7 };
    expect(parseNetMessage(pong)).toEqual(pong);
  });

  it("validates both identically", () => {
    // A pong is only ever used to compute a round trip, so there is no reason
    // for it to accept a field the ping would reject.
    for (const type of ["ping", "pong"]) {
      expect(parseNetMessage({ type, atMs: "1000", token: 1 })).toBeNull();
      expect(parseNetMessage({ type, atMs: 1000 })).toBeNull();
      expect(parseNetMessage({ type, token: 1 })).toBeNull();
    }
  });
});

describe("rematch and restart guards", () => {
  it("accepts a bare rematch request from a guest", () => {
    expect(parseNetMessage({ type: "rematch" })).toEqual({ type: "rematch" });
  });

  it("validates restart exactly like start", () => {
    // Reusing one shape means the grid assignment and go-at time cannot drift
    // between a first race and a rematch.
    const good = { type: "restart", settings, slots: { host: 0, g1: 1 }, atMs: 1234 };
    expect(parseNetMessage(good)).toEqual(good);
    expect(parseNetMessage({ type: "restart", settings, slots: { host: 0.5 }, atMs: 1 })).toBeNull();
    expect(parseNetMessage({ type: "restart", settings, slots: "none", atMs: 1 })).toBeNull();
    expect(parseNetMessage({ type: "restart", settings, atMs: 1 })).toBeNull();
    expect(parseNetMessage({ type: "restart", settings: { ...settings, mode: "practice" }, slots: {}, atMs: 1 })).toBeNull();
  });
});

describe("safety-car guard", () => {
  it("accepts the known states", () => {
    for (const phase of ["none", "active", "ending"]) {
      for (const kind of ["sc", "vsc"]) {
        const msg = { type: "safety-car", phase, kind };
        expect(parseNetMessage(msg)).toEqual(msg);
      }
    }
  });

  it("drops an unknown state instead of showing one", () => {
    // A guest that rendered an unknown neutralisation would race against
    // something the host is not actually enforcing.
    expect(parseNetMessage({ type: "safety-car", phase: "deployed", kind: "sc" })).toBeNull();
    expect(parseNetMessage({ type: "safety-car", phase: "active", kind: "f1" })).toBeNull();
    expect(parseNetMessage({ type: "safety-car", phase: "active" })).toBeNull();
  });
});

describe("host-left guard", () => {
  it("accepts a reason and rejects a missing one", () => {
    expect(parseNetMessage({ type: "host-left", reason: "Host closed the tab." })).toEqual({
      type: "host-left",
      reason: "Host closed the tab.",
    });
    expect(parseNetMessage({ type: "host-left" })).toBeNull();
    expect(parseNetMessage({ type: "host-left", reason: 42 })).toBeNull();
  });
});

describe("lobby readiness", () => {
  it("starts with nobody ready and the host not yet seated", () => {
    const state = room();
    expect(allReady(state)).toBe(false);
    expect(canStart(state)).toBe(false);
    // Both guests are waiting; the host is not in the list.
    expect(membersNotReady(state).map((m) => m.peerId)).toEqual(["g1", "g2"]);
  });

  it("becomes startable only when every guest has reported", () => {
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    expect(allReady(state)).toBe(false);
    // The host is not in the waiting list - it is not waiting on itself.
    expect(membersNotReady(state).map((m) => m.peerId)).toEqual(["g2"]);
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g2" });
    // The host's own readiness is implicit - it is running the room. It is
    // never sent as a `ready`, so allReady must not count it, or the start
    // button would never light up.
    expect(hostIsReady(state)).toBe(true);
    expect(allReady(state)).toBe(true);
    expect(canStart(state)).toBe(true);
  });

  it("does not let an empty room start", () => {
    // Otherwise a host who kicks everyone can deadlock on a start nobody
    // will ever confirm.
    const empty = createReadyLobbyState(true, settings);
    expect(allReady(empty)).toBe(false);
    expect(canStart(empty)).toBe(false);
    // A room with only the host in it is the same case: there is nobody to
    // wait for, but there is also nothing to race.
    let solo = readyLobbyReducer(createReadyLobbyState(true, settings), {
      type: "opened",
      selfId: "host",
      code: "ABC234",
    });
    solo = setHostDriver(solo, driver("VER"));
    expect(allReady(solo)).toBe(false);
  });

  it("reports the host's own row as ready in the broadcast table", () => {
    // A guest rendering the table that showed the host as still loading would
    // be waiting on someone who is never going to send anything.
    const rows = lobbyRows(room());
    expect(rows[0]).toMatchObject({ peerId: "host", ready: true });
  });

  it("ignores ready from a peer that is not in the roster", () => {
    // A stale `ready` from someone who already left must not reappear as a
    // phantom row that the host then waits on forever.
    let state = room();
    const before = state.members.length;
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "ghost" });
    expect(state.members).toHaveLength(before);
    expect(state.presence.ghost).toBeUndefined();
  });

  it("keeps presence across a membership change", () => {
    // THE test for why presence is a separate map rather than a field on the
    // member: members are rebuilt wholesale on join/leave, so state stored on
    // the member would be thrown away by a routine roster update and the
    // lobby would deadlock on a start nobody is ready for.
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g2" });
    state = readyLobbyReducer(state, { type: "member-joined", peerId: "g3", driver: driver("SAI") });
    expect(state.presence.g1?.ready).toBe(true);
    expect(state.presence.g2?.ready).toBe(true);
    // The newcomer is NOT ready, so the room is no longer startable.
    expect(allReady(state)).toBe(false);
  });

  it("forgets a member that leaves, so a rejoin starts clean", () => {
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    state = readyLobbyReducer(state, { type: "member-ping", peerId: "g1", pingMs: 30 });
    state = readyLobbyReducer(state, { type: "member-left", peerId: "g1" });
    expect(state.presence.g1).toBeUndefined();
    // Rejoining is a fresh presence, not a resurrected one - a browser reload
    // must not arrive pre-confirmed.
    state = readyLobbyReducer(state, { type: "member-joined", peerId: "g1", driver: driver("HAM") });
    expect(state.presence.g1).toEqual({ ready: false, pingMs: null });
  });

  it("takes the driver from ready, which is what makes a pre-race preview possible", () => {
    // `ready` is the only message a guest is guaranteed to send before the
    // race exists, so it is where a late driver pick has to arrive.
    let state = room();
    state = readyLobbyReducer(state, {
      type: "member-ready",
      peerId: "g1",
      driver: driver("RUS"),
    });
    expect(state.members.find((m) => m.peerId === "g1")?.driver.code).toBe("RUS");
    // Without one, the existing pick stands.
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g2" });
    expect(state.members.find((m) => m.peerId === "g2")?.driver.code).toBe("LEC");
  });

  it("can drop a member back to not-ready", () => {
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    state = readyLobbyReducer(state, { type: "member-unready", peerId: "g1" });
    expect(state.presence.g1?.ready).toBe(false);
    expect(allReady(state)).toBe(false);
  });

  it("still refuses to seat a member past the cap", () => {
    let state = room();
    for (let i = 0; i < MAX_NET_HUMANS; i += 1) {
      state = readyLobbyReducer(state, { type: "member-joined", peerId: `x${i}`, driver: driver("BOT") });
    }
    expect(state.members.length).toBe(MAX_NET_HUMANS);
    expect(state.notice).toBe("Room is full.");
  });

  it("resolves settings in the direction that matches who owns them", () => {
    // A `settings` event means "the host's settings arrived on the wire". So
    // the host IGNORES it (it is the authority and cannot be told what to run)
    // and a GUEST adopts it (that is the whole point of following the host).
    // The guard against a guest moving the race lives in the transport - only
    // the host ever broadcasts `settings` - not here, and confusing the two
    // is how you end up with a guest that can retarget everyone's session.
    const host = readyLobbyReducer(room(), { type: "settings", settings: { ...settings, track: "monaco" } });
    // The host's own settings are monza (that is what it created the room
    // with) and stay that way: it cannot be told what to run.
    expect(host.settings.track).toBe("monza");
    const guest = createReadyLobbyState(false, settings);
    const adopted = readyLobbyReducer(guest, { type: "settings", settings: { ...settings, track: "monaco" } });
    expect(adopted.settings.track).toBe("monaco");
  });
});

describe("lobby broadcast table", () => {
  it("mirrors the member order and carries readiness and latency", () => {
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    state = readyLobbyReducer(state, { type: "member-ping", peerId: "g1", pingMs: 55 });
    const rows = lobbyRows(state);
    expect(rows.map((r) => r.peerId)).toEqual(["host", "g1", "g2"]);
    expect(rows[0]).toMatchObject({ peerId: "host", ready: true, pingMs: null });
    expect(rows[1]).toMatchObject({ peerId: "g1", ready: true, pingMs: 55 });
    expect(rows[2]).toMatchObject({ peerId: "g2", ready: false, pingMs: null });
  });

  it("survives the protocol guard, so what is shown is what is sendable", () => {
    let state = room();
    state = readyLobbyReducer(state, { type: "member-ready", peerId: "g1" });
    state = readyLobbyReducer(state, { type: "member-ping", peerId: "g1", pingMs: 55 });
    expect(parseNetMessage({ type: "lobby-state", members: lobbyRows(state) })).not.toBeNull();
  });

  it("ignores latency from a peer that is not present", () => {
    const state = readyLobbyReducer(room(), { type: "member-ping", peerId: "ghost", pingMs: 10 });
    expect(state.presence.ghost).toBeUndefined();
  });
});

describe("lobby readiness authority", () => {
  /*
   * These cover the LOGIC behind two bugs that only live two-tab testing
   * found, expressed against the pure reducer so they stay cheap:
   *
   * 1. A guest cannot know whether the HOST is ready. It only ever receives
   *    the host's pings, and readiness is not something a ping carries. The
   *    first implementation had each peer infer every row from its own
   *    connection, so the guest rendered the host as "LOADING" permanently.
   *    The fix is that the host is the only authority and publishes a table.
   * 2. The published table must include the host's own row, reported ready.
   *    A table that omits or negates it is worse than no table: a guest
   *    waiting on a host who is never going to send anything.
   */
  it("the host's own row is the only one it can assert without being told", () => {
    const rows = lobbyRows(room());
    const hostRow = rows.find((r) => r.peerId === "host");
    const guestRow = rows.find((r) => r.peerId === "g1");
    // Nobody has reported, so the host must be ready (it runs the room) and
    // the guest must not (it never said so).
    expect(hostRow?.ready).toBe(true);
    expect(guestRow?.ready).toBe(false);
  });

  it("the published table changes only when a member actually reports", () => {
    // The table is broadcast on every change, so a stable table matters: a
    // guest re-rendering on every heartbeat would be a 2Hz re-render of the
    // whole lobby for a number that did not move.
    const before = lobbyRows(room());
    const after = readyLobbyReducer(room(), { type: "member-ping", peerId: "g1", pingMs: 40 });
    expect(lobbyRows(after)).not.toEqual(before);
    const same = readyLobbyReducer(after, { type: "member-ping", peerId: "g1", pingMs: 40 });
    expect(lobbyRows(same)).toEqual(lobbyRows(after));
  });
});

describe("existing lobby behaviour is unchanged", () => {
  it("keeps the host first and the slot derivation", () => {
    // The star topology's correctness rests on every peer deriving the same
    // grid independently, so this is the invariant to protect.
    const state = room();
    expect(state.members[0].peerId).toBe("host");
    expect(lobbySlots(state)).toEqual({ host: 0, g1: 1, g2: 2 });
  });

  it("leaves the plain reducer working for callers that do not need readiness", () => {
    // The generic signature is what makes this compose: a plain LobbyState
    // still reduces, and a ReadyLobbyState keeps its presence map through the
    // same code path.
    let state = createReadyLobbyState(true, settings);
    state = readyLobbyReducer(state, { type: "opened", selfId: "host", code: "ABC234" });
    state = setHostDriver(state, driver("VER"));
    expect(state.members).toHaveLength(1);
    expect(state.presence).toEqual({});
  });
});
