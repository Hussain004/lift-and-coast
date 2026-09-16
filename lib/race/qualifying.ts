/**
 * Plan section 7's "Playable Qualifying": whoever's first completed lap is
 * faster is on pole. This project has no session-phase system yet (no
 * menu, no distinct qualifying-then-race transition - see
 * implementation_plan.md section 8) so this isn't a separate session that
 * sets a real starting grid; it's an informational overlay on the existing
 * continuous Quick Race, reusing each car's own lap timer's first result.
 * A real grid-setting qualifying session needs the session-setup/results
 * screens this project doesn't have.
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
