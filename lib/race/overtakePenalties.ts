/**
 * Race control for overtaking while a yellow flag, virtual safety car or
 * safety car is in force.
 *
 * SCOPE, and the reason it is safe to add. This is a READ-ONLY observer of
 * where the cars are: it is handed the player's and the AI's progress
 * snapshots and returns warnings and penalties for the PLAYER. It changes no
 * control input, no force and no trajectory for any car, and in particular it
 * never touches the AI. That matters more than usual here, because the
 * project's first hard rule is that `lib/ai/pathFollower.ts` is
 * chaos-sensitive: a feature that changed what the AI did would put every
 * stability gate in the suite out of date. A penalty is a time charge on the
 * player, which is a pure bookkeeping consequence, so the AI keeps running
 * exactly the line it was validated on.
 *
 * WHY A PASS IS NOT JUST A POSITION CHANGE. The brief for this is "gains a
 * position by passing, not by the other car pitting or slowing", and that
 * distinction is the whole difficulty. A position can change without an
 * overtake for several reasons that must NOT be penalized:
 *
 *  - the other car went into the pit lane, so it drops back on the road;
 *  - the other car stopped (spun, stalled, damaged) and the player went by;
 *  - the other car is a lap down or a lap up, which is a blue-flag
 *    situation and not an overtake in the classification sense at all;
 *  - the player is in the pit lane, where passing is meaningless.
 *
 * So a pass is detected as an actual ORDER FLIP against one specific car -
 * the player going from behind that car to ahead of it, with a margin on both
 * sides - and then the exclusions above are applied. Position arithmetic alone
 * cannot do this, which is why the unit tests drive synthetic progress
 * sequences through it rather than asserting on a position number.
 *
 * THE LADDER follows the same shape as the track-limits ladder in
 * trackLimitSequence.ts, because it is the same race-control idea: the
 * stewards warn first, and a driver who keeps doing it pays. Two warnings,
 * then a time penalty that escalates. Every rung is a time charge, never a
 * force or a pace multiplier, so the 1750 N engine ceiling and every measured
 * acceleration envelope are untouched (ground rule 3).
 *
 * A NOTE ON THE FIRST TICK, since it is the obvious way to get this wrong: a
 * new opponent's remembered side is 0 ("order not yet established"), and a
 * pass needs a previous side of -1. So the very first observation of a car
 * can never be read as a pass, however far ahead of the player it starts.
 * That is why there is no separate "primed" flag.
 */

import type { RaceProgress } from "./racePosition";

/** What is currently restricting overtaking, most severe last. */
export type OvertakeRestriction = "none" | "yellow" | "vsc" | "sc";

/** Passed at the same instant the restriction appeared. */
export const OVERTAKE_RESTRICTED = true;

/**
 * Margin, meters, on BOTH sides of an order flip before it counts.
 *
 * Without it, two cars running side by side under a safety car produce a
 * position change every frame their totals cross, and the player would be
 * warned and then penalized repeatedly for a single move. Three metres is
 * small enough that a real completed pass registers immediately and large
 * enough to absorb the jitter of two cars at the same speed.
 */
export const OVERTAKE_PASS_MARGIN_METERS = 3;

/**
 * The other car must be moving faster than this for the pass to count as an
 * overtake rather than the player going round something that had stopped.
 *
 * Deliberately well below any racing speed including the slowest safety-car
 * ceiling (38 m/s, see SC_CAP_MS), so it cannot accidentally reject a real
 * pass; it exists only to catch a car that is entering the pit lane, has
 * spun, or has stalled.
 */
export const OVERTAKE_MIN_OPPONENT_SPEED_MS = 10;

/** Separate offences earn a warning before any penalty. */
export const OVERTAKE_WARNING_COUNT = 2;

/** Seconds charged for the 1st, 2nd, 3rd and later penalty, clamped at the top. */
export const OVERTAKE_PENALTY_LADDER_SECONDS: readonly number[] = [5, 10, 15];

/**
 * Minimum spacing between two counted offences, seconds. Two cars being
 * passed on the same corner is two real overtakes, but a single pass that
 * trips the detector twice within this window is one, and the stewards would
 * not write two tickets for it.
 */
export const OVERTAKE_OFFENCE_COOLDOWN_SECONDS = 2;

export function overtakePenaltySeconds(penaltyCount: number): number {
  if (penaltyCount < 1) return OVERTAKE_PENALTY_LADDER_SECONDS[0];
  return OVERTAKE_PENALTY_LADDER_SECONDS[
    Math.min(penaltyCount, OVERTAKE_PENALTY_LADDER_SECONDS.length) - 1
  ];
}

export function overtakePenaltyLabel(penaltyCount: number): string {
  if (penaltyCount < 1) return `+${OVERTAKE_PENALTY_LADDER_SECONDS[0]}s PENALTY`;
  const index = Math.min(penaltyCount, OVERTAKE_PENALTY_LADDER_SECONDS.length) - 1;
  return `+${OVERTAKE_PENALTY_LADDER_SECONDS[index]}s PENALTY`;
}

/** What the restriction is called on the radio and in Race Ops. */
export function overtakeRestrictionLabel(restriction: OvertakeRestriction): string {
  switch (restriction) {
    case "sc":
      return "SAFETY CAR";
    case "vsc":
      return "VSC";
    case "yellow":
      return "YELLOW FLAG";
    case "none":
      return "";
  }
}

/** -1 the player is behind, 1 ahead, 0 not yet established past the margin. */
type Side = -1 | 0 | 1;

export interface OvertakePenaltyState {
  /** Per-opponent order memory, in the same index order as `opponents`. */
  sides: Side[];
  /** The other car was in the pit on the previous tick, per opponent. */
  wasInPit: boolean[];
  /** Completed warning offences since the last penalty. */
  warnings: number;
  /** Distinct penalties awarded this race. */
  penaltyCount: number;
  /** Seconds charged by the most recent penalty. */
  lastPenaltySeconds: number;
  /** Clock of the last counted offence, for the cooldown. */
  lastOffenceSeconds: number;
  /** Bumps on every warning and penalty so a UI can react once. */
  serial: number;
}

export function createOvertakePenaltyState(opponents = 0): OvertakePenaltyState {
  return {
    sides: Array.from({ length: opponents }, () => 0 as Side),
    wasInPit: Array.from({ length: opponents }, () => false),
    warnings: 0,
    penaltyCount: 0,
    lastPenaltySeconds: 0,
    lastOffenceSeconds: -Infinity,
    serial: 0,
  };
}

/** Full reset, for a new race attempt. */
export function resetOvertakePenalties(state: OvertakePenaltyState, opponents?: number): void {
  Object.assign(state, createOvertakePenaltyState(opponents ?? state.sides.length));
}

export type OvertakePenaltyEvent =
  | {
      type: "warning";
      /** 1-based warning number within the current ladder run. */
      warningNumber: number;
      restriction: OvertakeRestriction;
      /** The car that was passed, when the caller supplied rival codes. */
      code: string | null;
    }
  | {
      type: "penalty";
      penaltyCount: number;
      penaltySeconds: number;
      restriction: OvertakeRestriction;
      code: string | null;
    };

export interface OvertakePenaltyInput {
  player: RaceProgress;
  opponents: readonly RaceProgress[];
  /** Rival driver codes, aligned with `opponents`, for the message. */
  codes?: readonly string[];
  trackLengthMeters: number;
  /** The restriction in force on THIS tick. */
  restriction: OvertakeRestriction;
  /** Lights out and no chequered flag. */
  racing: boolean;
  /** Session clock, seconds, for the cooldown and the decision's timestamp. */
  raceSeconds: number;
}

function totalDistance(progress: RaceProgress, trackLengthMeters: number): number {
  return progress.lapCount * trackLengthMeters + progress.progressMeters;
}

/**
 * Advances the detector by one tick and returns the single event it produced,
 * or null. At most one offence is registered per tick even if several cars
 * were passed at once, because two cars crossing on the same corner is one
 * incident to the stewards and two to a naive per-car loop.
 */
export function stepOvertakePenalties(
  state: OvertakePenaltyState,
  input: OvertakePenaltyInput
): OvertakePenaltyEvent | null {
  const trackLength = Math.max(1, input.trackLengthMeters);
  const playerTotal = totalDistance(input.player, trackLength);

  // Grow or shrink the per-opponent memory if the field changed size (a net
  // room can), PRESERVING the memory of the cars already in it. Wiping it
  // would silently forgive the whole field: a pass already completed against
  // car 0 would be forgotten and the next tick could not see it. New cars
  // start at 0 ("order not yet established"), so a car that joins can never
  // be read as passed on its first tick.
  if (state.sides.length !== input.opponents.length) {
    const keepSide = (index: number): Side => (index < state.sides.length ? state.sides[index] : 0);
    const keepPit = (index: number): boolean =>
      index < state.wasInPit.length ? state.wasInPit[index] : false;
    state.sides = Array.from({ length: input.opponents.length }, (_, index) => keepSide(index));
    state.wasInPit = Array.from({ length: input.opponents.length }, (_, index) => keepPit(index));
  }

  const restricted = input.racing && input.restriction !== "none";
  // `let` because registering an offence consumes the cooldown for the rest of
  // the tick, so a second car passed in the same instant cannot also count.
  let withinCooldown =
    input.raceSeconds - state.lastOffenceSeconds < OVERTAKE_OFFENCE_COOLDOWN_SECONDS;
  let event: OvertakePenaltyEvent | null = null;

  for (let k = 0; k < input.opponents.length; k++) {
    const opponent = input.opponents[k];
    if (!opponent) continue;
    const gap = playerTotal - totalDistance(opponent, trackLength);
    const previousSide = state.sides[k];
    // Only a gap past the margin on both sides is an established order.
    const side: Side = gap >= OVERTAKE_PASS_MARGIN_METERS ? 1 : gap <= -OVERTAKE_PASS_MARGIN_METERS ? -1 : 0;

    // A completed overtake: behind that specific car, now ahead of it.
    if (previousSide === -1 && side === 1) {
      const otherInPit = (opponent.inPit ?? false) || state.wasInPit[k];
      const playerInPit = input.player.inPit ?? false;
      // A car a lap apart is a blue-flag situation, not an overtake, so it is
      // excluded on lap count as well as by the wrap-around that a pure gap
      // comparison would otherwise read as a huge pass.
      const lapDifference = Math.abs(input.player.lapCount - opponent.lapCount);
      const otherStillMoving = Math.abs(opponent.speedMs ?? 0) >= OVERTAKE_MIN_OPPONENT_SPEED_MS;
      if (restricted && !otherInPit && !playerInPit && lapDifference < 1 && otherStillMoving && !withinCooldown) {
        state.lastOffenceSeconds = input.raceSeconds;
        withinCooldown = true;
        const code = input.codes?.[k] ?? null;
        if (state.warnings < OVERTAKE_WARNING_COUNT) {
          state.warnings += 1;
          state.serial += 1;
          event = {
            type: "warning",
            warningNumber: state.warnings,
            restriction: input.restriction,
            code,
          };
        } else {
          state.penaltyCount += 1;
          state.lastPenaltySeconds = overtakePenaltySeconds(state.penaltyCount);
          // A penalty resets the warning ladder, matching the track-limits
          // sequence: the next offence starts being warned again.
          state.warnings = 0;
          state.serial += 1;
          event = {
            type: "penalty",
            penaltyCount: state.penaltyCount,
            penaltySeconds: state.lastPenaltySeconds,
            restriction: input.restriction,
            code,
          };
        }
      }
    }

    state.sides[k] = side;
    state.wasInPit[k] = opponent.inPit ?? false;
  }

  return event;
}

/** The steward line for Race Ops / the penalty toast. */
export function overtakePenaltyMessage(event: OvertakePenaltyEvent): string {
  const where = overtakeRestrictionLabel(event.restriction);
  if (event.type === "warning") {
    return `Overtaking under ${where}: warning ${event.warningNumber}/${OVERTAKE_WARNING_COUNT}`;
  }
  return `Overtaking under ${where}: ${overtakePenaltyLabel(event.penaltyCount)}`;
}

/** The engineer's side of it, which is always the same shape of news. */
export function overtakeEngineerLine(event: OvertakePenaltyEvent): string {
  const where = overtakeRestrictionLabel(event.restriction);
  if (event.type === "warning") {
    const left = OVERTAKE_WARNING_COUNT - event.warningNumber + 1;
    return `Race control: overtaking under ${where}, that's a warning. ${left} more and it's a penalty.`;
  }
  return `Race control: ${overtakePenaltyLabel(event.penaltyCount)} for overtaking under ${where}.`;
}

/** HUD chip text, "" when there is nothing to show. */
export function overtakePenaltyText(state: OvertakePenaltyState): string {
  if (state.warnings > 0) {
    return `OVERTAKING UNDER FLAG: WARNING ${state.warnings}/${OVERTAKE_WARNING_COUNT}`;
  }
  if (state.penaltyCount > 0) {
    return `OVERTAKING UNDER FLAG: ${overtakePenaltyLabel(state.penaltyCount)}`;
  }
  return "";
}
