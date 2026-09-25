/**
 * Plan section 7's "Playable Qualifying": real grid-setting sessions behind
 * ?mode=qualifying (see QualifyingSession below) - one-shot (a single
 * flying lap) or timed (10 minutes, best valid lap). The grid spot feeds
 * the staggered race start. QualifyingTimes/polePosition below are the
 * older informational overlay (first completed laps, shown during races);
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

export type QualifyingFormat = "oneshot" | "timed";

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
  /** Seconds left (timed) - hits 0 exactly when the session ends. */
  timeLeftSeconds: number;
  /** Completed laps (oneshot) - the player's first crossing ends the session. */
  lapsDone: number;
  finished: boolean;
}

export function createQualifyingSession(format: QualifyingFormat, opponents = 0): QualifyingSession {
  return {
    format,
    best: { player: null, opponents: Array.from({ length: opponents }, () => null) },
    timeLeftSeconds: TIMED_QUALIFYING_SECONDS,
    lapsDone: 0,
    finished: false,
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

/** Advances a timed session; the clock floor ends it exactly at zero. */
export function tickQualifyingSession(session: QualifyingSession, dt: number): QualifyingSession {
  if (session.finished || session.format !== "timed") return session;
  const timeLeftSeconds = Math.max(0, session.timeLeftSeconds - dt);
  return { ...session, timeLeftSeconds, finished: timeLeftSeconds <= 0 };
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
