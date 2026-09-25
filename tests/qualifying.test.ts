import { describe, expect, it } from "vitest";
import {
  TIMED_QUALIFYING_SECONDS,
  createQualifyingSession,
  createQualifyingTimes,
  isQualifyingLapValid,
  playerGridSpot,
  polePosition,
  qualifyingLeaderboard,
  qualifyingWinner,
  recordQualiLap,
  tickQualifyingSession,
  sessionGridOrder,
} from "../lib/race/qualifying";

describe("polePosition", () => {
  it("is null until the player and a rival both have a time", () => {
    expect(polePosition(createQualifyingTimes())).toBeNull();
    expect(polePosition({ player: 90, opponents: [null] })).toBeNull();
    expect(polePosition({ player: null, opponents: [90] })).toBeNull();
  });

  it("picks whichever side is faster once both are in", () => {
    expect(polePosition({ player: 88, opponents: [90] })).toBe("player");
    expect(polePosition({ player: 92, opponents: [90] })).toBe(0);
  });

  it("returns the fastest rival's index in a full field", () => {
    expect(polePosition({ player: 95, opponents: [92, 90, 93] })).toBe(1);
    expect(polePosition({ player: 89, opponents: [92, 90, 93] })).toBe("player");
    // Rivals without a time never win.
    expect(polePosition({ player: 95, opponents: [null, null] })).toBeNull();
  });

  it("breaks an exact tie in favor of the player, matching computeRacePositions", () => {
    expect(polePosition({ player: 90, opponents: [90] })).toBe("player");
  });
});

describe("qualifyingLeaderboard", () => {
  it("classifies the player and rivals with leader/player gaps", () => {
    const board = qualifyingLeaderboard(
      { player: 90, opponents: [92, 88, null] },
      "YOU",
      ["VER", "LEC", "NOR"]
    );
    expect(board.map((entry) => [entry.position, entry.code])).toEqual([
      [1, "LEC"],
      [2, "YOU"],
      [3, "VER"],
      [4, "NOR"],
    ]);
    expect(board[0].gapToLeaderSeconds).toBe(0);
    expect(board[1].gapToLeaderSeconds).toBeCloseTo(2, 6);
    expect(board[1].gapToPlayerSeconds).toBe(0);
    expect(board[2].gapToPlayerSeconds).toBeCloseTo(2, 6);
    expect(board[3].gapToPlayerSeconds).toBeNull();
  });

  it("keeps no-time entries behind the classified field", () => {
    const board = qualifyingLeaderboard(
      { player: null, opponents: [null, 95, 97] },
      "YOU",
      ["A", "B", "C"]
    );
    expect(board.map((entry) => entry.code)).toEqual(["B", "C", "YOU", "A"]);
    expect(board.every((entry) => entry.gapToPlayerSeconds === null)).toBe(true);
    expect(board[0].gapToLeaderSeconds).toBe(0);
    expect(board[1].gapToLeaderSeconds).toBe(2);
    expect(board[2].gapToLeaderSeconds).toBeNull();
    expect(board[3].gapToLeaderSeconds).toBeNull();
  });
});

describe("isQualifyingLapValid", () => {
  it("accepts a corrected rewind but rejects a remaining track-limit violation", () => {
    expect(isQualifyingLapValid(false, false)).toBe(true);
    expect(isQualifyingLapValid(false, true)).toBe(false);
    expect(isQualifyingLapValid(true, false)).toBe(false);
    expect(isQualifyingLapValid(true, true)).toBe(false);
  });
});

describe("QualifyingSession", () => {
  it("starts unfinished with no times and a full clock", () => {
    const timed = createQualifyingSession("timed", 1);
    expect(timed.finished).toBe(false);
    expect(timed.best).toEqual({ player: null, opponents: [null] });
    expect(timed.timeLeftSeconds).toBe(TIMED_QUALIFYING_SECONDS);
    const oneshot = createQualifyingSession("oneshot", 1);
    expect(oneshot.finished).toBe(false);
    expect(qualifyingWinner(oneshot)).toBeNull();
  });

  it("keeps the best valid lap per side and ignores invalid ones", () => {
    let session = createQualifyingSession("timed", 1);
    session = recordQualiLap(session, "player", 95);
    session = recordQualiLap(session, "player", 92);
    session = recordQualiLap(session, "player", 94);
    session = recordQualiLap(session, 0, null);
    expect(session.best.player).toBe(92);
    expect(session.best.opponents).toEqual([null]);
    expect(qualifyingWinner(session)).toBe("player");
    expect(session.finished).toBe(false);
  });

  it("tracks each rival separately", () => {
    let session = createQualifyingSession("timed", 3);
    session = recordQualiLap(session, 0, 95);
    session = recordQualiLap(session, 2, 90);
    session = recordQualiLap(session, 0, 93);
    expect(session.best.opponents).toEqual([93, null, 90]);
    expect(qualifyingWinner(session)).toBe(2);
    // No player time yet: behind both timed rivals.
    expect(playerGridSpot(session)).toBe(3);
  });

  it("ends a one-shot on the player's lap, not the rivals'", () => {
    let session = createQualifyingSession("oneshot", 1);
    session = recordQualiLap(session, 0, 90);
    expect(session.finished).toBe(false);
    session = recordQualiLap(session, "player", 88);
    expect(session.finished).toBe(true);
    expect(qualifyingWinner(session)).toBe("player");
    // Finished sessions ignore further laps.
    const same = recordQualiLap(session, "player", 80);
    expect(same.best.player).toBe(88);
  });

  it("an invalidated one-shot leaves the driver with no time (last)", () => {
    let session = createQualifyingSession("oneshot", 2);
    session = recordQualiLap(session, 0, 90);
    session = recordQualiLap(session, 1, 95);
    session = recordQualiLap(session, "player", null);
    expect(session.finished).toBe(true);
    expect(session.best.player).toBeNull();
    expect(playerGridSpot(session)).toBe(3);
  });

  it("counts the clock down and finishes a timed session at zero", () => {
    let session = createQualifyingSession("timed");
    session = tickQualifyingSession(session, TIMED_QUALIFYING_SECONDS - 1);
    expect(session.finished).toBe(false);
    expect(session.timeLeftSeconds).toBe(1);
    session = tickQualifyingSession(session, 2);
    expect(session.finished).toBe(true);
    expect(session.timeLeftSeconds).toBe(0);
  });

  it("never lets the clock go negative or tick a finished session", () => {
    let session = createQualifyingSession("timed");
    session = tickQualifyingSession(session, TIMED_QUALIFYING_SECONDS + 100);
    const frozen = tickQualifyingSession(session, 10);
    expect(frozen.timeLeftSeconds).toBe(0);
    expect(frozen.finished).toBe(true);
  });

  it("breaks exact ties for the player and defaults to P1 with no contest", () => {
    let session = createQualifyingSession("timed", 1);
    session = recordQualiLap(session, "player", 90);
    session = recordQualiLap(session, 0, 90);
    expect(qualifyingWinner(session)).toBe("player");
    expect(playerGridSpot(session)).toBe(1);
    const empty = createQualifyingSession("timed");
    expect(playerGridSpot(empty)).toBe(1);
  });

  it("spots the player mid-field in a full field", () => {
    let session = createQualifyingSession("timed", 4);
    session = recordQualiLap(session, 0, 88);
    session = recordQualiLap(session, 1, 92);
    session = recordQualiLap(session, 2, 90);
    session = recordQualiLap(session, 3, null);
    session = recordQualiLap(session, "player", 91);
    // 88 and 90 beat 91; 92 and the no-time lose to it: P3.
    expect(playerGridSpot(session)).toBe(3);
  });
});

describe("sessionGridOrder", () => {
  it("sorts every side by best, no-times last, player wins ties", () => {
    const order = sessionGridOrder(
      { player: 90, opponents: [88, null, 90] },
      "YOU",
      ["A", "B", "C"]
    );
    expect(order).toEqual(["A", "YOU", "C", "B"]);
  });

  it("covers the whole field with no drops", () => {
    const order = sessionGridOrder(
      { player: null, opponents: [null, 95] },
      "YOU",
      ["A", "B"]
    );
    expect(order).toEqual(["B", "YOU", "A"]);
  });
});
