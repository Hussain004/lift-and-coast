import { describe, expect, it } from "vitest";
import {
  OVERTAKE_MIN_OPPONENT_SPEED_MS,
  OVERTAKE_OFFENCE_COOLDOWN_SECONDS,
  OVERTAKE_PASS_MARGIN_METERS,
  OVERTAKE_PENALTY_LADDER_SECONDS,
  OVERTAKE_WARNING_COUNT,
  createOvertakePenaltyState,
  overtakeEngineerLine,
  overtakePenaltyLabel,
  overtakePenaltyMessage,
  overtakePenaltySeconds,
  overtakePenaltyText,
  overtakeRestrictionLabel,
  resetOvertakePenalties,
  stepOvertakePenalties,
  type OvertakePenaltyEvent,
  type OvertakePenaltyInput,
  type OvertakePenaltyState,
  type OvertakeRestriction,
} from "../lib/race/overtakePenalties";
import type { RaceProgress } from "../lib/race/racePosition";

/**
 * Pass-detection tests for the yellow / VSC / safety-car overtaking penalty.
 *
 * Everything here drives SYNTHETIC PROGRESS SEQUENCES through the detector
 * rather than asserting on a computed position, because the whole difficulty
 * of this feature is that a position change and an overtake are not the same
 * event. The sequences below are the real cases that have to be right:
 * a genuine pass, a pass while unrestricted, and - the ones a position-based
 * implementation would get wrong - a car pitting, a car that stopped, and a
 * car a lap down.
 */

const TRACK = 5000; // metres, a round number so laps are easy to read

interface Car extends RaceProgress {
  code?: string;
}

const car = (over: Partial<Car> = {}): Car => ({
  lapCount: 1,
  progressMeters: 0,
  speedMs: 40,
  ...over,
});

/** Runs a sequence of ticks, collecting every event produced. */
function run(
  state: OvertakePenaltyState,
  ticks: OvertakePenaltyInput[]
): OvertakePenaltyEvent[] {
  const events: OvertakePenaltyEvent[] = [];
  for (const input of ticks) {
    const event = stepOvertakePenalties(state, input);
    if (event) events.push(event);
  }
  return events;
}

const tick = (
  player: Car,
  opponents: Car[],
  restriction: OvertakeRestriction,
  raceSeconds: number
): OvertakePenaltyInput => ({
  player,
  opponents,
  codes: opponents.map((o) => o.code ?? "RIV"),
  trackLengthMeters: TRACK,
  restriction,
  racing: true,
  raceSeconds,
});

/** Two ticks: establish the order, then flip it. The pass is on the 2nd. */
function passSequence(
  from: Partial<Car>,
  to: Partial<Car>,
  restriction: OvertakeRestriction,
  startSeconds = 0
): OvertakePenaltyInput[] {
  const opponentBefore = car({ progressMeters: 100, ...from });
  const opponentAfter = car({ progressMeters: 100, ...to });
  return [
    tick(car({ progressMeters: opponentBefore.progressMeters - 20 }), [opponentBefore], restriction, startSeconds),
    tick(car({ progressMeters: opponentAfter.progressMeters + 20 }), [opponentAfter], restriction, startSeconds + 1),
  ];
}

describe("overtake pass detection", () => {
  it("warns for a genuine pass made while a restriction is in force", () => {
    const state = createOvertakePenaltyState(1);
    const events = run(state, passSequence({}, {}, "vsc"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "warning", warningNumber: 1, restriction: "vsc" });
    expect(state.warnings).toBe(1);
    expect(state.penaltyCount).toBe(0);
  });

  it("ignores the same pass when nothing is restricting overtaking", () => {
    const state = createOvertakePenaltyState(1);
    expect(run(state, passSequence({}, {}, "none"))).toHaveLength(0);
    expect(state.warnings).toBe(0);
  });

  it("ignores a pass before lights out and after the flag", () => {
    const state = createOvertakePenaltyState(1);
    const ticks = passSequence({}, {}, "sc");
    const notRacing = ticks.map((t) => ({ ...t, racing: false }));
    expect(run(state, notRacing)).toHaveLength(0);
    expect(state.warnings).toBe(0);
  });

  it("does not read the opening tick as a pass, however far ahead the field starts", () => {
    // The classic false positive: the player starts P20, so every car is
    // "ahead" of them on the first observation. That must not be a pass.
    const state = createOvertakePenaltyState(2);
    const far = car({ progressMeters: 4000, lapCount: 3 });
    const events = run(state, [
      tick(car({ progressMeters: 10, lapCount: 1 }), [far, far], "sc", 0),
    ]);
    expect(events).toHaveLength(0);
    expect(state.warnings).toBe(0);
  });

  it("needs the margin on both sides, so side-by-side jitter is not a pass", () => {
    // Two cars running wheel to wheel under a safety car cross the gap
    // repeatedly. Only an order established past the margin, then broken the
    // other way, counts - and here it never gets past the margin at all.
    const state = createOvertakePenaltyState(1);
    const opponent = car({ progressMeters: 500 });
    const events = run(state, [
      tick(car({ progressMeters: 500 - OVERTAKE_PASS_MARGIN_METERS - 1 }), [opponent], "sc", 0),
      tick(car({ progressMeters: 500 - 1 }), [opponent], "sc", 1),
      tick(car({ progressMeters: 500 + 1 }), [opponent], "sc", 2),
      tick(car({ progressMeters: 500 - 1 }), [opponent], "sc", 3),
      tick(car({ progressMeters: 500 + 1 }), [opponent], "sc", 4),
    ]);
    expect(events).toHaveLength(0);
    expect(state.warnings).toBe(0);
  });

  it("counts one offence, not several, when two cars cross on the same corner", () => {
    const state = createOvertakePenaltyState(2);
    const a = car({ progressMeters: 200, code: "AAA" });
    const b = car({ progressMeters: 210, code: "BBB" });
    const events = run(state, [
      tick(car({ progressMeters: 150 }), [a, b], "sc", 0),
      tick(car({ progressMeters: 260 }), [a, b], "sc", 5),
    ]);
    expect(events).toHaveLength(1);
    expect(state.warnings).toBe(1);
  });
});

describe("what must NOT count as a pass", () => {
  it("ignores a car that went into the pit lane", () => {
    // The player never passed anybody: the rival pitted and dropped back.
    const state = createOvertakePenaltyState(1);
    const onTrack = car({ progressMeters: 300 });
    const pitted = car({ progressMeters: 250, speedMs: 20, inPit: true });
    const events = run(state, [
      tick(car({ progressMeters: 200 }), [onTrack], "vsc", 0),
      tick(car({ progressMeters: 400 }), [pitted], "vsc", 1),
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores a pass completed on the same tick the rival entered the pit", () => {
    // Tighter: the rival is flagged in the pit on the very tick the player
    // goes by, so the pass must still not count.
    const state = createOvertakePenaltyState(1);
    const events = run(state, [
      tick(car({ progressMeters: 200 }), [car({ progressMeters: 300 })], "vsc", 0),
      tick(car({ progressMeters: 400 }), [car({ progressMeters: 300, inPit: true, speedMs: 18 })], "vsc", 1),
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores a car that has stopped on the racing surface", () => {
    // Same shape as pitting but on track: a spun or stalled car. The player
    // going round it is not an overtake under a yellow.
    const state = createOvertakePenaltyState(1);
    const events = run(state, [
      tick(car({ progressMeters: 200 }), [car({ progressMeters: 300, speedMs: 40 })], "yellow", 0),
      tick(
        car({ progressMeters: 400 }),
        [car({ progressMeters: 300, speedMs: OVERTAKE_MIN_OPPONENT_SPEED_MS - 1 })],
        "yellow",
        1
      ),
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores a car a lap down, which is a blue-flag situation", () => {
    const state = createOvertakePenaltyState(1);
    const onSameLap = car({ lapCount: 1, progressMeters: 300 });
    const aLapDown = car({ lapCount: 0, progressMeters: 300, speedMs: 38 });
    const events = run(state, [
      tick(car({ lapCount: 1, progressMeters: 200 }), [onSameLap], "sc", 0),
      tick(car({ lapCount: 1, progressMeters: 400 }), [aLapDown], "sc", 1),
    ]);
    expect(events).toHaveLength(0);
  });

  it("ignores the player being in the pit lane", () => {
    const state = createOvertakePenaltyState(1);
    const events = run(state, [
      tick(car({ progressMeters: 200 }), [car({ progressMeters: 300 })], "vsc", 0),
      tick(
        car({ progressMeters: 400, inPit: true, speedMs: 20 }),
        [car({ progressMeters: 300 })],
        "vsc",
        1
      ),
    ]);
    expect(events).toHaveLength(0);
  });

  it("still counts a pass by a car that is genuinely racing", () => {
    // The control for all the exclusions above: the same pass geometry, with
    // the rival at safety-car pace, DOES count. Otherwise the exclusions
    // would pass their tests by breaking the feature entirely.
    const state = createOvertakePenaltyState(1);
    const events = run(state, [
      tick(car({ progressMeters: 200 }), [car({ progressMeters: 300, speedMs: 38 })], "sc", 0),
      tick(car({ progressMeters: 400 }), [car({ progressMeters: 300, speedMs: 38 })], "sc", 1),
    ]);
    expect(events).toHaveLength(1);
  });
});

describe("warning then penalty ladder", () => {
  it("warns twice, then penalises, restarting the warnings for each penalty", () => {
    // The shape mirrors the track-limits ladder exactly: the WARNING run
    // restarts after a penalty, while the penalty COUNT keeps climbing, so
    // repeat offences escalate. The first version of this test wrongly
    // expected back-to-back penalties, which would have meant a player got no
    // warning at all after their first one.
    const state = createOvertakePenaltyState(1);
    const kinds: string[] = [];
    const pass = (seconds: number): OvertakePenaltyEvent | null => {
      // Put the player behind again between offences so each flip is a
      // separate, completed pass rather than one repeated jitter.
      run(state, [tick(car({ progressMeters: 100 }), [car({ progressMeters: 300 })], "sc", seconds)]);
      return stepOvertakePenalties(
        state,
        tick(car({ progressMeters: 500 }), [car({ progressMeters: 300 })], "sc", seconds + 0.5)
      );
    };
    let seconds = 0;
    for (let offence = 0; offence < 7; offence += 1) {
      const event = pass(seconds);
      expect(event, `offence ${offence}`).not.toBeNull();
      kinds.push(event!.type === "penalty" ? `penalty:${event!.penaltySeconds}` : "warning");
      seconds += OVERTAKE_OFFENCE_COOLDOWN_SECONDS + 1;
    }
    expect(kinds).toEqual([
      "warning",
      "warning",
      `penalty:${OVERTAKE_PENALTY_LADDER_SECONDS[0]}`,
      "warning",
      "warning",
      `penalty:${OVERTAKE_PENALTY_LADDER_SECONDS[1]}`,
      "warning",
    ]);
    expect(state.penaltyCount).toBe(2);
  });

  it("resets the warning ladder after a penalty, like the track-limits sequence", () => {
    const state = createOvertakePenaltyState(1);
    const pass = (seconds: number): OvertakePenaltyEvent | null => {
      run(state, [tick(car({ progressMeters: 100 }), [car({ progressMeters: 300 })], "sc", seconds)]);
      return stepOvertakePenalties(
        state,
        tick(car({ progressMeters: 500 }), [car({ progressMeters: 300 })], "sc", seconds + 0.5)
      );
    };
    let seconds = 0;
    // Two warnings, then a penalty.
    for (let i = 0; i < OVERTAKE_WARNING_COUNT + 1; i += 1) {
      pass(seconds);
      seconds += OVERTAKE_OFFENCE_COOLDOWN_SECONDS + 1;
    }
    expect(state.penaltyCount).toBe(1);
    expect(state.warnings).toBe(0);
    // ...so the next one warns again rather than penalising immediately.
    expect(pass(seconds)?.type).toBe("warning");
  });

  it("clamps the penalty ladder at its top rung", () => {
    expect(overtakePenaltySeconds(1)).toBe(OVERTAKE_PENALTY_LADDER_SECONDS[0]);
    expect(overtakePenaltySeconds(99)).toBe(
      OVERTAKE_PENALTY_LADDER_SECONDS[OVERTAKE_PENALTY_LADDER_SECONDS.length - 1]
    );
    expect(overtakePenaltyLabel(99)).toBe(
      `+${OVERTAKE_PENALTY_LADDER_SECONDS[OVERTAKE_PENALTY_LADDER_SECONDS.length - 1]}s PENALTY`
    );
  });

  it("every rung is a bounded time charge, never a force or a pace factor", () => {
    // The whole feature has to stay inside ground rule 3: a penalty may only
    // ever be time, and the ladder is deliberately small next to a drive-through.
    for (let i = 0; i < 20; i += 1) {
      const seconds = overtakePenaltySeconds(i);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(15);
    }
  });
});

describe("field changes and resets", () => {
  it("survives the field growing or shrinking without inventing a pass", () => {
    const state = createOvertakePenaltyState(1);
    // Establish an order against one car, then the field doubles.
    run(state, [tick(car({ progressMeters: 100 }), [car({ progressMeters: 300 })], "sc", 0)]);
    const events = run(state, [
      tick(car({ progressMeters: 500 }), [car({ progressMeters: 300 }), car({ progressMeters: 320 })], "sc", 5),
    ]);
    // The pre-existing car's pass is real; the newly added car must not be
    // read as one, because its remembered side starts unknown.
    expect(events).toHaveLength(1);
  });

  it("reset clears the ladder and the remembered order", () => {
    const state = createOvertakePenaltyState(1);
    run(state, [
      tick(car({ progressMeters: 100 }), [car({ progressMeters: 300 })], "sc", 0),
      tick(car({ progressMeters: 500 }), [car({ progressMeters: 300 })], "sc", 5),
    ]);
    expect(state.warnings).toBe(1);
    resetOvertakePenalties(state, 1);
    expect(state.warnings).toBe(0);
    expect(state.penaltyCount).toBe(0);
    expect(state.sides).toEqual([0]);
    // And no pass is detectable from the reset state alone.
    expect(stepOvertakePenalties(state, tick(car({ progressMeters: 500 }), [car({ progressMeters: 300 })], "sc", 6))).toBeNull();
  });
});

describe("messages", () => {
  it("names the restriction the pass was made under", () => {
    expect(overtakeRestrictionLabel("sc")).toBe("SAFETY CAR");
    expect(overtakeRestrictionLabel("vsc")).toBe("VSC");
    expect(overtakeRestrictionLabel("yellow")).toBe("YELLOW FLAG");
    expect(overtakeRestrictionLabel("none")).toBe("");
  });

  it("gives the steward line and the engineer line for both rungs", () => {
    const warning: OvertakePenaltyEvent = {
      type: "warning",
      warningNumber: 1,
      restriction: "sc",
      code: "HAM",
    };
    const penalty: OvertakePenaltyEvent = {
      type: "penalty",
      penaltyCount: 1,
      penaltySeconds: 5,
      restriction: "yellow",
      code: "HAM",
    };
    expect(overtakePenaltyMessage(warning)).toContain("SAFETY CAR");
    expect(overtakePenaltyMessage(penalty)).toContain("YELLOW FLAG");
    expect(overtakeEngineerLine(warning)).toContain("warning");
    expect(overtakeEngineerLine(penalty)).toContain("+5s PENALTY");
    // Both name the restriction, so a player always learns WHICH flag they
    // were caught out under.
    expect(overtakeEngineerLine(warning)).toContain("SAFETY CAR");
  });

  it("shows nothing on the HUD until something has happened", () => {
    const state = createOvertakePenaltyState(1);
    expect(overtakePenaltyText(state)).toBe("");
    state.warnings = 1;
    expect(overtakePenaltyText(state)).toContain(`WARNING 1/${OVERTAKE_WARNING_COUNT}`);
    state.warnings = 0;
    state.penaltyCount = 1;
    expect(overtakePenaltyText(state)).toContain("+5s PENALTY");
  });
});
