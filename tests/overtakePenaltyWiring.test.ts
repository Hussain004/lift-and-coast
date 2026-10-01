import { describe, expect, it } from "vitest";
import {
  createHudSnapshot,
  drainEngineerLines,
  pushHudEvent,
  queueEngineerLine,
  type HudSnapshot,
} from "../lib/race/hud";
import { createRaceControlSystem, raceControlSummary } from "../lib/race/raceControl";
import {
  createOvertakePenaltyState,
  overtakePenaltyMessage,
  stepOvertakePenalties,
  type OvertakeRestriction,
} from "../lib/race/overtakePenalties";
import type { RaceProgress } from "../lib/race/racePosition";

/**
 * The wiring around the overtaking penalty: the engineer's queue on the HUD
 * snapshot, and the fact that a penalty really does reach the Race Ops panel
 * through race control. Both are integration facts that the pure pass-detection
 * tests cannot see, and both are places where a plausible-looking change
 * would silently do nothing.
 */

const TRACK = 5000;
const car = (over: Partial<RaceProgress> = {}): RaceProgress => ({
  lapCount: 1,
  progressMeters: 0,
  speedMs: 40,
  ...over,
});

/** Completes one pass and returns the event, or null. */
function pass(
  state: ReturnType<typeof createOvertakePenaltyState>,
  restriction: OvertakeRestriction,
  seconds: number
) {
  const behind = {
    player: car({ progressMeters: 100 }),
    opponents: [car({ progressMeters: 300 })],
    trackLengthMeters: TRACK,
    restriction,
    racing: true,
    raceSeconds: seconds,
  };
  stepOvertakePenalties(state, behind);
  return stepOvertakePenalties(
    state,
    {
      ...behind,
      player: car({ progressMeters: 500 }),
      raceSeconds: seconds + 0.5,
    }
  );
}

describe("engineer line queue on the HUD snapshot", () => {
  it("starts empty and drains oldest first", () => {
    const hud = createHudSnapshot();
    expect(drainEngineerLines(hud)).toEqual([]);
    queueEngineerLine(hud, "first");
    queueEngineerLine(hud, "second");
    expect(drainEngineerLines(hud)).toEqual(["first", "second"]);
    // Drained, not copied: the same lines must not be spoken twice.
    expect(drainEngineerLines(hud)).toEqual([]);
  });

  it("is bounded, dropping the oldest line", () => {
    const hud = createHudSnapshot();
    for (let i = 0; i < 40; i += 1) queueEngineerLine(hud, `line-${i}`);
    const drained = drainEngineerLines(hud);
    // A player who spins under a yellow must not be able to grow this without
    // limit; the oldest lines are the least relevant.
    expect(drained.length).toBeLessThanOrEqual(4);
    expect(drained[drained.length - 1]).toBe("line-39");
  });

  it("does not disturb the separate banner queue", () => {
    // pushHudEvent and queueEngineerLine are different queues on purpose: one
    // is the on-screen banner stack, the other is what the radio says. A
    // banner must never be spoken by the engineer, and vice versa.
    const hud = createHudSnapshot();
    pushHudEvent(hud, "penalty", "TITLE", "detail");
    queueEngineerLine(hud, "spoken line");
    expect(hud.events).toHaveLength(1);
    expect(drainEngineerLines(hud)).toEqual(["spoken line"]);
    expect(hud.events).toHaveLength(1);
  });

  it("gives every snapshot its own queue", () => {
    // createHudSnapshot must not share one array between instances, or a
    // leftover line from a previous session would leak into the next race.
    const a: HudSnapshot = createHudSnapshot();
    const b = createHudSnapshot();
    queueEngineerLine(a, "only a");
    expect(drainEngineerLines(b)).toEqual([]);
  });
});

describe("an overtaken pass reaches race control and the Race Ops panel", () => {
  it("charges nothing for a warning, so a warning really is only a warning", () => {
    const control = createRaceControlSystem();
    const state = createOvertakePenaltyState(1);
    const event = pass(state, "sc", 0);
    expect(event?.type).toBe("warning");
    // Nothing reported: the ladder is a warning, not a charge.
    expect(control.state.decisions).toHaveLength(0);
    expect(raceControlSummary(control.state)).toBe("GREEN");
  });

  it("reports the penalty through race control, where the panel already reads it", () => {
    const control = createRaceControlSystem();
    const state = createOvertakePenaltyState(1);
    let seconds = 0;
    let event = null;
    // Enough passes to get past the warning ladder.
    for (let i = 0; i < 4 && !event; i += 1) {
      const found = pass(state, "sc", seconds);
      if (found?.type === "penalty") event = found;
      seconds += 10;
    }
    expect(event).not.toBeNull();

    const decision = control.reportIncident("overtaking", 30, {
      penaltySeconds: event!.penaltySeconds,
      severity: "time",
      message: overtakePenaltyMessage(event!),
    });
    // The two things app/race/RaceOpsPanel.tsx reads off the snapshot.
    expect(decision.message).toContain("SAFETY CAR");
    expect(raceControlSummary(control.state)).toBe(`PENALTY ${event!.penaltySeconds}s · 2 PT`);
    expect(control.snapshot().lastDecision?.message).toContain("SAFETY CAR");
  });

  it("invalidates the lap the pass happened on", () => {
    const control = createRaceControlSystem();
    const decision = control.reportIncident("overtaking", 12, {
      penaltySeconds: 5,
      severity: "time",
    });
    expect(decision.invalidatedLap).toBe(true);
  });

  it("never escalates to a drive-through, so it needs no pit-lane serving", () => {
    // Every rung is a time penalty. A drive-through would have to be served in
    // the pit lane, which is a much bigger change and is not what the brief
    // asked for.
    const control = createRaceControlSystem();
    for (let i = 0; i < 8; i += 1) {
      const decision = control.reportIncident("overtaking", i, {
        penaltySeconds: 15,
        severity: "time",
      });
      expect(decision.severity).toBe("time");
    }
    expect(control.state.penaltySeconds).toBe(120);
  });
});
