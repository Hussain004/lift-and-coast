import { describe, expect, it } from "vitest";
import {
  TIMED_QUALIFYING_SECONDS,
  createQualifyingSession,
  createQualifyingTimes,
  playerGridSpot,
  polePosition,
  qualifyingWinner,
  recordQualiLap,
  tickQualifyingSession,
} from "../lib/race/qualifying";

describe("polePosition", () => {
  it("is null until both sides have a time", () => {
    expect(polePosition(createQualifyingTimes())).toBeNull();
    expect(polePosition({ player: 90, ai: null })).toBeNull();
    expect(polePosition({ player: null, ai: 90 })).toBeNull();
  });

  it("picks whichever side is faster once both are in", () => {
    expect(polePosition({ player: 88, ai: 90 })).toBe("player");
    expect(polePosition({ player: 92, ai: 90 })).toBe("ai");
  });

  it("breaks an exact tie in favor of the player, matching computeRacePosition", () => {
    expect(polePosition({ player: 90, ai: 90 })).toBe("player");
  });
});

describe("QualifyingSession", () => {
  it("starts unfinished with no times and a full clock", () => {
    const timed = createQualifyingSession("timed");
    expect(timed.finished).toBe(false);
    expect(timed.best).toEqual({ player: null, ai: null });
    expect(timed.timeLeftSeconds).toBe(TIMED_QUALIFYING_SECONDS);
    const oneshot = createQualifyingSession("oneshot");
    expect(oneshot.finished).toBe(false);
    expect(qualifyingWinner(oneshot)).toBeNull();
  });

  it("keeps the best valid lap per side and ignores invalid ones", () => {
    let session = createQualifyingSession("timed");
    session = recordQualiLap(session, "player", 95);
    session = recordQualiLap(session, "player", 92);
    session = recordQualiLap(session, "player", 94);
    session = recordQualiLap(session, "ai", null);
    expect(session.best.player).toBe(92);
    expect(session.best.ai).toBeNull();
    expect(qualifyingWinner(session)).toBe("player");
    expect(session.finished).toBe(false);
  });

  it("ends a one-shot on the player's lap, not the AI's", () => {
    let session = createQualifyingSession("oneshot");
    session = recordQualiLap(session, "ai", 90);
    expect(session.finished).toBe(false);
    session = recordQualiLap(session, "player", 88);
    expect(session.finished).toBe(true);
    expect(qualifyingWinner(session)).toBe("player");
    // Finished sessions ignore further laps.
    const same = recordQualiLap(session, "player", 80);
    expect(same.best.player).toBe(88);
  });

  it("an invalidated one-shot leaves the driver with no time (P2)", () => {
    let session = createQualifyingSession("oneshot");
    session = recordQualiLap(session, "ai", 90);
    session = recordQualiLap(session, "player", null);
    expect(session.finished).toBe(true);
    expect(session.best.player).toBeNull();
    expect(playerGridSpot(session)).toBe(2);
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
    let session = createQualifyingSession("timed");
    session = recordQualiLap(session, "player", 90);
    session = recordQualiLap(session, "ai", 90);
    expect(qualifyingWinner(session)).toBe("player");
    expect(playerGridSpot(session)).toBe(1);
    const empty = createQualifyingSession("timed");
    expect(playerGridSpot(empty)).toBe(1);
  });
});
