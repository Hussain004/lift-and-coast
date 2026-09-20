import { describe, expect, it } from "vitest";
import {
  ROOM_CODE_LENGTH,
  isRoomCode,
  makeRoomCode,
  parseNetMessage,
  roomPeerId,
  slotForPeer,
} from "../lib/net/protocol";

describe("room codes", () => {
  it("makes short URL-safe codes the guard accepts", () => {
    for (let k = 0; k < 20; k++) {
      const code = makeRoomCode();
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isRoomCode(code)).toBe(true);
    }
    expect(isRoomCode("abc")).toBe(false);
    expect(isRoomCode("ABC-12")).toBe(false);
    expect(isRoomCode(null)).toBe(false);
    expect(isRoomCode(" ABCDEF".slice(1))).toBe(true);
  });

  it("namespaces peer ids per room", () => {
    expect(roomPeerId("ABC123")).toContain("ABC123");
    expect(roomPeerId("ABC123")).not.toBe(roomPeerId("XYZ789"));
  });
});

describe("parseNetMessage", () => {
  it("drops garbage, unknown types and version mismatches", () => {
    expect(parseNetMessage(null)).toBeNull();
    expect(parseNetMessage("hello")).toBeNull();
    expect(parseNetMessage({ type: "nope" })).toBeNull();
    expect(parseNetMessage({ type: "hello", version: 999, driver: { code: "A", name: "B", teamId: "C", color: "#fff" } })).toBeNull();
  });

  it("accepts roster members with peer ids", () => {
    const msg = parseNetMessage({
      type: "roster",
      roster: [{ peerId: "p1", driver: { code: "VER", name: "V", teamId: "t", color: "#fff" } }],
    });
    expect(msg).not.toBeNull();
    expect(
      parseNetMessage({ type: "roster", roster: [{ peerId: "p1", driver: { code: "VER" } }] })
    ).toBeNull();
  });

  it("accepts a hello with a well-formed driver", () => {
    const msg = parseNetMessage({
      type: "hello",
      version: 1,
      driver: { code: "VER", name: "V", teamId: "red-bull", color: "#3671c6" },
    });
    expect(msg).toEqual({
      type: "hello",
      version: 1,
      driver: { code: "VER", name: "V", teamId: "red-bull", color: "#3671c6" },
    });
  });

  it("clamps input axes into range instead of trusting the guest", () => {
    const msg = parseNetMessage({ type: "input", seq: 7, throttle: 2, brake: -1, steer: 5 });
    expect(msg).toEqual({ type: "input", seq: 7, throttle: 1, brake: 0, steer: 1 });
    expect(parseNetMessage({ type: "input", seq: 7, throttle: 1, brake: 0 })).toBeNull();
  });

  it("rejects malformed snapshots and results", () => {
    expect(
      parseNetMessage({ type: "snapshot", tick: 1, cars: [{ slot: 0 }], tower: [] })
    ).toBeNull();
    expect(
      parseNetMessage({ type: "results", positions: { a: 1.5 }, winnerCode: "VER" })
    ).toBeNull();
    expect(
      parseNetMessage({ type: "results", positions: { VER: 1 }, winnerCode: "VER" })
    ).toBeNull();
    const ok = parseNetMessage({
      type: "results",
      positions: { 0: 1, 1: 2 },
      winnerCode: "VER",
    });
    expect(ok).toEqual({ type: "results", positions: { 0: 1, 1: 2 }, winnerCode: "VER" });
  });

  it("rejects non-race settings", () => {
    expect(
      parseNetMessage({ type: "settings", settings: { track: "spa", mode: "practice", laps: 3, rivals: 1, tod: "day" } })
    ).toBeNull();
    expect(
      parseNetMessage({ type: "settings", settings: { track: "spa", mode: "race", laps: 3, rivals: 1, tod: "day" } })
    ).not.toBeNull();
  });
});

describe("slotForPeer", () => {
  it("derives grid order from join order", () => {
    expect(slotForPeer(["a", "b", "c"], "a")).toBe(0);
    expect(slotForPeer(["a", "b", "c"], "c")).toBe(2);
    expect(slotForPeer(["a", "b"], "z")).toBe(-1);
  });
});

describe("leave handshake", () => {
  it("round-trips bye and error reasons, rejecting non-strings", () => {
    expect(parseNetMessage({ type: "bye", reason: "Leader left the room." })).toEqual({
      type: "bye",
      reason: "Leader left the room.",
    });
    expect(parseNetMessage({ type: "error", reason: "Room is full." })).toEqual({
      type: "error",
      reason: "Room is full.",
    });
    expect(parseNetMessage({ type: "bye", reason: 42 })).toBeNull();
    expect(parseNetMessage({ type: "bye" })).toBeNull();
  });
});
