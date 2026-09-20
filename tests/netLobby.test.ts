import { describe, expect, it } from "vitest";
import {
  MAX_NET_HUMANS,
  initialLobbyState,
  lobbyReducer,
  lobbySlots,
  setHostDriver,
} from "../lib/net/lobby";
import type { NetSettings } from "../lib/net/protocol";

const SETTINGS: NetSettings = { track: "spa", mode: "race", laps: 3, rivals: 1, tod: "day" };
const driver = (code: string) => ({ code, name: code, teamId: "t", color: "#ffffff" });

describe("lobbyReducer", () => {
  it("opens with self and code", () => {
    const first = lobbyReducer(initialLobbyState(true, SETTINGS), {
      type: "opened",
      selfId: "host-peer",
      code: "ABC123",
    });
    expect(first.selfId).toBe("host-peer");
    expect(first.code).toBe("ABC123");
    expect(first.members).toEqual([]);
  });

  it("seats the host first, then guests in join order", () => {
    let state = initialLobbyState(true, SETTINGS);
    state = lobbyReducer(state, { type: "opened", selfId: "host-peer", code: "ABC123" });
    state = setHostDriver(state, driver("VER"));
    state = lobbyReducer(state, { type: "member-joined", peerId: "guest-1", driver: driver("NOR") });
    expect(state.members.map((m) => m.peerId)).toEqual(["host-peer", "guest-1"]);
    expect(lobbySlots(state)).toEqual({ "host-peer": 0, "guest-1": 1 });
  });

  it("refuses joins past the human cap and duplicate joins", () => {
    let state = initialLobbyState(true, SETTINGS);
    state = lobbyReducer(state, { type: "opened", selfId: "h", code: "ABC123" });
    state = setHostDriver(state, driver("VER"));
    for (let k = 0; k < MAX_NET_HUMANS; k++) {
      state = lobbyReducer(state, { type: "member-joined", peerId: `g${k}`, driver: driver(`D${k}`) });
    }
    expect(state.members.length).toBe(MAX_NET_HUMANS);
    const full = lobbyReducer(state, { type: "member-joined", peerId: "late", driver: driver("LATE") });
    expect(full.members.length).toBe(MAX_NET_HUMANS);
    expect(full.notice).toBe("Room is full.");
  });

  it("drops members on leave, ignoring unknown ones", () => {
    let state = initialLobbyState(true, SETTINGS);
    state = lobbyReducer(state, { type: "opened", selfId: "h", code: "ABC123" });
    state = lobbyReducer(state, { type: "member-joined", peerId: "g", driver: driver("NOR") });
    state = lobbyReducer(state, { type: "member-left", peerId: "nobody" });
    expect(state.members.length).toBe(1);
    state = lobbyReducer(state, { type: "member-left", peerId: "g" });
    expect(state.members.length).toBe(0);
  });

  it("only guests accept host settings", () => {
    const guest = lobbyReducer(initialLobbyState(false, SETTINGS), {
      type: "settings",
      settings: { ...SETTINGS, track: "monza" },
    });
    expect(guest.settings.track).toBe("monza");
    const host = { ...initialLobbyState(true, SETTINGS) };
    const kept = lobbyReducer(host, {
      type: "settings",
      settings: { ...SETTINGS, track: "monza" },
    });
    expect(kept.settings.track).toBe("spa");
  });
});

describe("full rooms", () => {
  it("seats host + 7 guests with slots 0..7, refusing the 8th guest", () => {
    let state = initialLobbyState(true, SETTINGS);
    state = lobbyReducer(state, { type: "opened", selfId: "h", code: "ABC123" });
    state = setHostDriver(state, driver("HOST"));
    expect(MAX_NET_HUMANS).toBe(8);
    for (let k = 0; k < 7; k++) {
      state = lobbyReducer(state, { type: "member-joined", peerId: `g${k}`, driver: driver(`D${k}`) });
      expect(state.notice).toBeNull();
    }
    expect(state.members.length).toBe(8);
    expect(lobbySlots(state)).toEqual({
      h: 0, g0: 1, g1: 2, g2: 3, g3: 4, g4: 5, g5: 6, g6: 7,
    });
    const full = lobbyReducer(state, { type: "member-joined", peerId: "late", driver: driver("LATE") });
    expect(full.members.length).toBe(8);
    expect(full.notice).toBe("Room is full.");
    // A leaver frees exactly their slot: join order after them is unchanged.
    const freed = lobbyReducer(full, { type: "member-left", peerId: "g2" });
    const rejoined = lobbyReducer(freed, { type: "member-joined", peerId: "new", driver: driver("NEW") });
    expect(rejoined.members.length).toBe(8);
    expect(lobbySlots(rejoined)["new"]).toBe(7);
  });
});
