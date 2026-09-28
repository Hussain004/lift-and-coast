// Race finish rules, F1 style, as pure functions over per-car lap counts:
// the chequered flag comes out when the LEADER (any car, AI included)
// completes the race distance, and from then on every car is classified the
// next time it crosses the line - lapped cars included, one lap short.
// Car.tsx feeds this every frame; the results screen shows the rows.
import { pointsForPosition } from "./championship";
import type { ClassifiedRow } from "./hud";

export interface FinishTracker {
  chequered: boolean;
  finalLapCalled: boolean;
  /** Each car's completed laps when the flag came out. */
  lapsAtFlag: number[];
  /** Race clock at each car's finish, null while still running. */
  finishClock: (number | null)[];
  /** Laps each car had completed when it was classified. */
  finishLaps: number[];
}

export function createFinishTracker(cars: number): FinishTracker {
  return {
    chequered: false,
    finalLapCalled: false,
    lapsAtFlag: new Array(cars).fill(0),
    finishClock: new Array(cars).fill(null),
    finishLaps: new Array(cars).fill(0),
  };
}

export interface FinishUpdate {
  /** The flag came out this call. */
  chequeredNow: boolean;
  /** The leader just started the last lap (race distance > 1 lap). */
  finalLapNow: boolean;
  /** Indices of cars that took the flag this call. */
  finishedNow: number[];
}

/**
 * Advances the finish state. `laps[i]` is car i's completed laps (index 0
 * is the player by convention; the tracker itself does not care).
 */
export function updateFinishTracker(
  tracker: FinishTracker,
  laps: readonly number[],
  raceLaps: number,
  clock: number
): FinishUpdate {
  const out: FinishUpdate = { chequeredNow: false, finalLapNow: false, finishedNow: [] };
  let leaderLaps = 0;
  for (const l of laps) if (l > leaderLaps) leaderLaps = l;
  if (!tracker.finalLapCalled && raceLaps > 1 && leaderLaps >= raceLaps - 1 && leaderLaps < raceLaps) {
    tracker.finalLapCalled = true;
    out.finalLapNow = true;
  }
  if (!tracker.chequered && leaderLaps >= raceLaps) {
    tracker.chequered = true;
    tracker.finalLapCalled = true;
    out.chequeredNow = true;
    // A car that crossed on this same frame as the leader counts from the
    // lap it was on BEFORE the flag, so it finishes now rather than a lap later.
    for (let i = 0; i < laps.length; i++) tracker.lapsAtFlag[i] = Math.min(laps[i], raceLaps - 1);
  }
  if (!tracker.chequered) return out;
  for (let i = 0; i < laps.length; i++) {
    if (tracker.finishClock[i] !== null) continue;
    if (laps[i] >= raceLaps || laps[i] > tracker.lapsAtFlag[i]) {
      tracker.finishClock[i] = clock;
      tracker.finishLaps[i] = laps[i];
      out.finishedNow.push(i);
    }
  }
  return out;
}

export interface ClassificationEntrant {
  code: string;
  name: string | null;
  teamId: string | null;
  color: string;
  isPlayer: boolean;
  /** Completed laps right now (used for cars still running). */
  laps: number;
  /** Live running order, used to place cars that have not finished. */
  livePosition: number;
  bestLapSeconds: number | null;
  penaltySeconds: number;
}

/**
 * Final classification: finishers by laps completed, then race time with
 * penalties added (so a time penalty can drop a driver behind a car that
 * finished just after them); cars still running at the end are classified
 * behind every finisher in their live order.
 */
export function classifyRace(
  entrants: readonly ClassificationEntrant[],
  tracker: FinishTracker
): ClassifiedRow[] {
  let fastest: number | null = null;
  for (const e of entrants) {
    if (e.bestLapSeconds !== null && (fastest === null || e.bestLapSeconds < fastest)) fastest = e.bestLapSeconds;
  }
  const rows = entrants.map((e, i) => {
    const clock = tracker.finishClock[i];
    return {
      entrant: e,
      finished: clock !== null,
      laps: clock !== null ? tracker.finishLaps[i] : e.laps,
      total: clock !== null ? clock + e.penaltySeconds : null,
    };
  });
  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.laps !== b.laps) return b.laps - a.laps;
    if (a.finished && b.finished) return (a.total as number) - (b.total as number);
    return a.entrant.livePosition - b.entrant.livePosition;
  });
  return rows.map((row, index) => ({
    position: index + 1,
    code: row.entrant.code,
    name: row.entrant.name,
    teamId: row.entrant.teamId,
    color: row.entrant.color,
    isPlayer: row.entrant.isPlayer,
    totalSeconds: row.total,
    laps: row.laps,
    bestLapSeconds: row.entrant.bestLapSeconds,
    penaltySeconds: row.entrant.penaltySeconds,
    points: pointsForPosition(index + 1),
    fastestLap: fastest !== null && row.entrant.bestLapSeconds === fastest,
  }));
}
