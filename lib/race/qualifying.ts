/**
 * Plan section 7's "Playable Qualifying": real grid-setting sessions behind
 * ?mode=qualifying (see QualifyingSession below) - one-shot (a single
 * flying lap), timed (open session, best valid lap), or knockout (the real
 * F1 format: Q1/Q2/Q3 with eliminations between phases). The grid spot
 * feeds the staggered race start. QualifyingTimes/polePosition below are
 * the older informational overlay (first completed laps, shown during races);
 * the session machine is the authority wherever a grid is set.
 *
 * Full field: the player (index "player") plus one slot per rival in
 * roster order (see resolveFieldRoster) - bests nobody set read null and
 * sort behind every real time.
 */
export interface QualifyingTimes {
  player: number | null;
  opponents: (number | null)[];
}

export function createQualifyingTimes(opponents = 0): QualifyingTimes {
  return { player: null, opponents: Array.from({ length: opponents }, () => null) };
}

/**
 * Who's on pole, or null until the player and at least one rival both
 * have a time. Returns "player" or the rival's index. Player wins an
 * exact tie, matching computeRacePositions' own tie-break convention in
 * racePosition.ts.
 */
export function polePosition(times: QualifyingTimes): "player" | number | null {
  if (times.player === null) return null;
  let best: "player" | number = "player";
  let bestTime = times.player;
  for (let k = 0; k < times.opponents.length; k++) {
    const t = times.opponents[k];
    if (t === null) continue;
    if (t < bestTime) {
      bestTime = t;
      best = k;
    }
  }
  // Null only when no rival has a time yet (bestTime stayed the player's
  // only if at least one rival time exists... no: best stays "player"
  // with zero rival times too). Require a contest: pole is undecided
  // until somebody else posts.
  if (best === "player" && !times.opponents.some((t) => t !== null)) return null;
  return best;
}

export type QualifyingFormat = "oneshot" | "timed" | "knockout";

/**
 * The three knockout phases, in order. Q1 is the whole field with the
 * slowest share eliminated, Q2 is the survivors with a second cut, Q3 is
 * the top-ten shootout for pole.
 */
export type QualifyingPhase = "Q1" | "Q2" | "Q3";

export const QUALIFYING_PHASES: readonly QualifyingPhase[] = ["Q1", "Q2", "Q3"];

/**
 * Phase clocks. Real F1 runs 18/15/12 minutes; this build scales the same
 * 1.5 : 1.25 : 1 ratio down to game-length sessions (3:00 / 2:30 / 2:00)
 * so a full knockout weekend still fits a single sitting.
 */
export const QUALIFYING_PHASE_SECONDS: Record<QualifyingPhase, number> = {
  Q1: 180,
  Q2: 150,
  Q3: 120,
};

export function nextPhase(phase: QualifyingPhase): QualifyingPhase | null {
  const index = QUALIFYING_PHASES.indexOf(phase);
  return index >= 0 && index < QUALIFYING_PHASES.length - 1
    ? QUALIFYING_PHASES[index + 1]
    : null;
}

/**
 * Validity for the player's classified lap. A rewind is allowed when the
 * player rewound before the offending excursion and is driving cleanly again;
 * a remaining track-limit violation still invalidates the lap. Continuous
 * timing for the delta/ghost reference is tracked separately by Car.tsx.
 */
export function isQualifyingLapValid(
  trackLimitsInvalid: boolean,
  timingDiscontinuity: boolean
): boolean {
  return !trackLimitsInvalid && !timingDiscontinuity;
}

/** Timed qualifying session length: 10 minutes of open track. */
export const TIMED_QUALIFYING_SECONDS = 600;

export interface QualifyingLeaderboardEntry {
  code: string;
  time: number | null;
  /** One-based classification position, including no-time entries. */
  position: number;
  /** Seconds behind the fastest classified time; null when nobody has a time. */
  gapToLeaderSeconds: number | null;
  /** Seconds relative to the player's best; null when the player has no time. */
  gapToPlayerSeconds: number | null;
  isPlayer: boolean;
}

/**
 * Classifies the complete qualifying field for the post-session result.
 * Null times sort behind every classified car, and exact ties put the player
 * first, matching playerGridSpot/sessionGridOrder below.
 */
export function qualifyingLeaderboard(
  times: QualifyingTimes,
  playerCode: string,
  rivalCodes: readonly string[]
): QualifyingLeaderboardEntry[] {
  const entries = [
    { code: playerCode, time: times.player, isPlayer: true, tieIndex: -1 },
    ...rivalCodes.map((code, index) => ({
      code,
      time: times.opponents[index] ?? null,
      isPlayer: false,
      tieIndex: index,
    })),
  ].sort((a, b) => {
    if (a.time === null && b.time === null) return a.tieIndex - b.tieIndex;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    if (a.time !== b.time) return a.time - b.time;
    return a.tieIndex - b.tieIndex;
  });

  const leaderTime = entries.find((entry) => entry.time !== null)?.time ?? null;
  const playerTime = times.player;
  return entries.map((entry, index) => ({
    code: entry.code,
    time: entry.time,
    position: index + 1,
    gapToLeaderSeconds:
      leaderTime === null || entry.time === null ? null : entry.time - leaderTime,
    gapToPlayerSeconds:
      playerTime === null || entry.time === null ? null : entry.time - playerTime,
    isPlayer: entry.isPlayer,
  }));
}

export type QualifyingSide = "player" | number;

export interface QualifyingSession {
  format: QualifyingFormat;
  /** Best VALID lap per side; null means no clean lap yet. */
  best: { player: number | null; opponents: (number | null)[] };
  /** Seconds left (timed/knockout) - hits 0 exactly when the session ends. */
  timeLeftSeconds: number;
  /** Completed laps (oneshot) - the player's first crossing ends the session. */
  lapsDone: number;
  finished: boolean;
  /** Knockout only: which phase the session is in (null for other formats). */
  phase: QualifyingPhase | null;
  /** Knockout only: seconds left in the current phase. */
  phaseTimeLeftSeconds: number;
  /** Knockout only: per side, true once knocked out of the session. */
  eliminated: boolean[];
  /**
   * Knockout only: sides cut at the most recent phase boundary (empty until
   * the first cut), so the HUD can name who went out.
   */
  lastEliminatedSides: QualifyingSide[];
  /** Knockout only: true once the player has been eliminated (session over for them). */
  playerEliminated: boolean;
}

function createBest(opponents: number): QualifyingSession["best"] {
  return { player: null, opponents: Array.from({ length: opponents }, () => null) };
}

export function createQualifyingSession(format: QualifyingFormat, opponents = 0): QualifyingSession {
  const knockout = format === "knockout";
  return {
    format,
    best: createBest(opponents),
    timeLeftSeconds: knockout ? QUALIFYING_PHASE_SECONDS.Q1 : TIMED_QUALIFYING_SECONDS,
    lapsDone: 0,
    finished: false,
    phase: knockout ? "Q1" : null,
    phaseTimeLeftSeconds: knockout ? QUALIFYING_PHASE_SECONDS.Q1 : 0,
    eliminated: Array.from({ length: opponents + 1 }, () => false),
    lastEliminatedSides: [],
    playerEliminated: false,
  };
}

function readBest(session: QualifyingSession, side: QualifyingSide): number | null {
  return side === "player" ? session.best.player : (session.best.opponents[side] ?? null);
}

function writeBest(
  best: QualifyingSession["best"],
  side: QualifyingSide,
  seconds: number
): QualifyingSession["best"] {
  if (side === "player") {
    return { ...best, player: seconds };
  }
  const opponents = [...best.opponents];
  opponents[side] = seconds;
  return { ...best, opponents };
}

/**
 * Records a finished lap. `seconds` is null for an invalidated (all four
 * wheels off) lap - it counts toward the oneshot lap total but can never
 * set a time, so blowing the one flyer leaves the driver with nothing,
 * same as the real rule. Only the player's laps advance a one-shot: the
 * session is their one flyer, ending when they complete it (rivals' bests
 * at that moment count if set) - rivals circulating extra laps must not
 * end the player's session early.
 */
export function recordQualiLap(
  session: QualifyingSession,
  side: QualifyingSide,
  seconds: number | null
): QualifyingSession {
  if (session.finished) return session;
  let best = session.best;
  if (seconds !== null) {
    const prev = readBest(session, side);
    if (prev === null || seconds < prev) {
      best = writeBest(best, side, seconds);
    }
  }
  const lapsDone =
    session.format === "oneshot" && side === "player" ? session.lapsDone + 1 : session.lapsDone;
  return {
    ...session,
    best,
    lapsDone,
    finished: session.format === "oneshot" ? lapsDone >= 1 : session.finished,
  };
}

/**
 * How many cars a knockout phase cuts. Real F1 eliminates 5 of 20 in Q1 and
 * 5 of 15 in Q2 - a quarter, then a third. Scaled to smaller fields, and
 * never so deep that Q3 would run with fewer than two cars.
 */
function eliminationCount(remaining: number): number {
  const cut = Math.max(1, Math.floor(remaining / 4));
  return Math.min(cut, Math.max(0, remaining - 2));
}

/**
 * Advances a timed session; the clock floor ends it exactly at zero. For a
 * knockout session each phase boundary cuts the slowest share of the
 * survivors and starts the next phase's clock; the end of Q3 finishes the
 * session. A player who is eliminated is done immediately - their grid
 * spot is locked by the time they did set.
 */
export function tickQualifyingSession(session: QualifyingSession, dt: number): QualifyingSession {
  if (session.finished) return session;
  if (session.format === "timed") {
    const timeLeftSeconds = Math.max(0, session.timeLeftSeconds - dt);
    return { ...session, timeLeftSeconds, finished: timeLeftSeconds <= 0 };
  }
  if (session.format !== "knockout" || session.phase === null) return session;

  const phaseTimeLeftSeconds = Math.max(0, session.phaseTimeLeftSeconds - dt);
  const timeLeftSeconds = Math.max(0, session.timeLeftSeconds - dt);
  if (phaseTimeLeftSeconds > 0) {
    return { ...session, phaseTimeLeftSeconds, timeLeftSeconds };
  }

  // Phase over: rank the survivors by best valid lap (no-time sides sort
  // last, roster order breaking ties) and cut the slowest share.
  const sides: QualifyingSide[] = [
    "player",
    ...session.best.opponents.map((_, index) => index as number),
  ];
  const survivors = sides.filter((side) => !session.eliminated[sideIndex(side)]);
  const ranked = [...survivors].sort((a, b) => {
    const ta = readBest(session, a);
    const tb = readBest(session, b);
    if (ta === null && tb === null) return sideIndex(a) - sideIndex(b);
    if (ta === null) return 1;
    if (tb === null) return -1;
    if (ta !== tb) return ta - tb;
    return sideIndex(a) - sideIndex(b);
  });
  const cut = eliminationCount(ranked.length);
  const eliminatedSides = ranked.slice(ranked.length - cut);
  const eliminated = [...session.eliminated];
  for (const side of eliminatedSides) eliminated[sideIndex(side)] = true;

  const playerEliminated =
    session.playerEliminated || eliminatedSides.includes("player");

  const next = nextPhase(session.phase);
  // Q3's end (or the player being cut) finishes the session.
  if (next === null || playerEliminated) {
    return {
      ...session,
      eliminated,
      lastEliminatedSides: eliminatedSides,
      playerEliminated,
      phaseTimeLeftSeconds: 0,
      timeLeftSeconds: 0,
      finished: true,
    };
  }
  return {
    ...session,
    eliminated,
    lastEliminatedSides: eliminatedSides,
    playerEliminated,
    phase: next,
    phaseTimeLeftSeconds: QUALIFYING_PHASE_SECONDS[next],
    timeLeftSeconds,
  };
}

function sideIndex(side: QualifyingSide): number {
  return side === "player" ? 0 : side + 1;
}

/**
 * Session winner by best valid lap - null while the player and every rival
 * with a time... precisely: null while nobody has a clean lap. Exact ties
 * go to the player (see polePosition). A side with no time always loses
 * to a side with one, so an invalidated one-shot means P2-or-worse.
 */
export function qualifyingWinner(session: QualifyingSession): QualifyingSide | null {
  let best: QualifyingSide | null = null;
  let bestTime: number | null = null;
  const consider = (side: QualifyingSide, time: number | null) => {
    if (time === null) return;
    if (bestTime === null || time < bestTime) {
      bestTime = time;
      best = side;
    }
  };
  consider("player", session.best.player);
  session.best.opponents.forEach((time, k) => consider(k, time));
  return best;
}

/** The player's grid spot from a finished session (1-based). */
export function playerGridSpot(session: QualifyingSession): number {
  const winner = qualifyingWinner(session);
  if (winner === null || winner === "player") return 1;
  // Count every side strictly faster than the player's best (plus one for
  // pole): rivals without a time sort behind, so with no player time the
  // player starts behind every rival who set one.
  const playerBest = session.best.player;
  let spot = 1;
  for (const time of session.best.opponents) {
    if (time === null) continue;
    if (playerBest === null || time < playerBest) spot += 1;
  }
  return spot;
}

/**
 * Full grid order from a finished session: every side's code sorted by
 * best valid lap (no-time sorts behind, exact ties break toward the
 * player first, then roster order), for the quali -> race handoff (see
 * ?order=). Before the grid order only the player's own spot traveled,
 * so AI rivals always lined up in roster order no matter who was fastest
 * - pole and P20 rarely belonged to anyone who earned them.
 */
export function sessionGridOrder(
  best: { player: number | null; opponents: (number | null)[] },
  playerCode: string,
  rivalCodes: readonly string[]
): string[] {
  return qualifyingLeaderboard(best, playerCode, rivalCodes).map((entry) => entry.code);
}
