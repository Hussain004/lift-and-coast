/**
 * Plan section 7's "Playable Qualifying": real grid-setting sessions behind
 * ?mode=qualifying (see QualifyingSession below) - one-shot (a single
 * flying lap) or timed (10 minutes, best valid lap). The grid spot feeds
 * the staggered race start. QualifyingTimes/polePosition below are the
 * older informational overlay (first completed laps, shown during races);
 * the session machine is the authority wherever a grid is set.
 */
export interface QualifyingTimes {
  player: number | null;
  ai: number | null;
}

export function createQualifyingTimes(): QualifyingTimes {
  return { player: null, ai: null };
}

/**
 * Who's on pole, or null until both sides have set a time. Player wins an
 * exact tie, matching computeRacePosition's own tie-break convention in
 * racePosition.ts.
 */
export function polePosition(times: QualifyingTimes): "player" | "ai" | null {
  if (times.player === null || times.ai === null) return null;
  return times.player <= times.ai ? "player" : "ai";
}

export type QualifyingFormat = "oneshot" | "timed";

/** Timed qualifying session length: 10 minutes of open track. */
export const TIMED_QUALIFYING_SECONDS = 600;

export type QualifyingSide = "player" | "ai";

export interface QualifyingSession {
  format: QualifyingFormat;
  /** Best VALID lap per side; null means no clean lap yet. */
  best: Record<QualifyingSide, number | null>;
  /** Seconds left (timed) - hits 0 exactly when the session ends. */
  timeLeftSeconds: number;
  /** Completed laps (oneshot) - the player's first crossing ends the session. */
  lapsDone: number;
  finished: boolean;
}

export function createQualifyingSession(format: QualifyingFormat): QualifyingSession {
  return {
    format,
    best: { player: null, ai: null },
    timeLeftSeconds: TIMED_QUALIFYING_SECONDS,
    lapsDone: 0,
    finished: false,
  };
}

/**
 * Records a finished lap. `seconds` is null for an invalidated (all four
 * wheels off) lap - it counts toward the oneshot lap total but can never
 * set a time, so blowing the one flyer leaves the driver with nothing,
 * same as the real rule. Only the player's laps advance a one-shot: the
 * session is their one flyer, ending when they complete it (the AI's best
 * at that moment counts if set) - the AI circulating extra laps must not
 * end the player's session early.
 */
export function recordQualiLap(
  session: QualifyingSession,
  side: QualifyingSide,
  seconds: number | null
): QualifyingSession {
  if (session.finished) return session;
  const best = { ...session.best };
  if (seconds !== null && (best[side] === null || seconds < best[side])) {
    best[side] = seconds;
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
 * Session winner by best valid lap - null while neither side has a clean
 * lap. Exact ties go to the player (see polePosition). A side with no time
 * always loses to a side with one, so an invalidated one-shot means P2.
 */
export function qualifyingWinner(session: QualifyingSession): QualifyingSide | null {
  const { player, ai } = session.best;
  if (player === null && ai === null) return null;
  if (player === null) return "ai";
  if (ai === null) return "player";
  return player <= ai ? "player" : "ai";
}

/** The player's grid spot from a finished session - P2 with no time. */
export function playerGridSpot(session: QualifyingSession): 1 | 2 {
  return qualifyingWinner(session) === "ai" ? 2 : 1;
}
