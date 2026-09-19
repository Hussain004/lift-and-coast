// Plan sections 7, 8 and 10: Championship mode - a season run across the
// registered circuits with F1-style points, persisted in IndexedDB (see
// lib/persistence/championship.ts) and shown on the home screen. Pure logic
// only (no storage, no React) so the points/standings bookkeeping is
// unit-testable without a browser.
//
// Field size: this build races the player against the single verified AI
// opponent, so a round is a two-car result. The points table is written out
// as a full F1-style list anyway (positions 3+ just never occur yet) so
// widening the field later is a data/AI change rather than a rewrite of the
// scoring rules. `aiPoints` below assumes exactly one opponent - the car
// that is not the player - which is the piece that changes with field size.
import { isKnownTrackId } from "../tracks/registry";

/** Plan section 7: F1-style points (25-18-15-...). */
export const CHAMPIONSHIP_POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export function pointsForPosition(position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return CHAMPIONSHIP_POINTS[position - 1] ?? 0;
}

export interface ChampionshipRound {
  trackId: string;
  /** Player's finishing position; null until the round has been raced. */
  playerPosition: number | null;
  /**
   * Player's grid spot from this weekend's qualifying (1 = pole); null
   * until qualified. The race is only offered once this is set - a
   * championship weekend runs practice (optional) -> qualifying -> race.
   */
  qualiSpot: 1 | 2 | null;
}

export interface ChampionshipSeason {
  schemaVersion: 1;
  createdAt: string;
  rounds: ChampionshipRound[];
}

export function createSeason(
  trackIds: readonly string[],
  createdAt: string
): ChampionshipSeason {
  return {
    schemaVersion: 1,
    createdAt,
    rounds: trackIds.map((trackId) => ({ trackId, playerPosition: null, qualiSpot: null })),
  };
}

export function totalRounds(season: ChampionshipSeason): number {
  return season.rounds.length;
}

export function completedRounds(season: ChampionshipSeason): number {
  return season.rounds.filter((round) => round.playerPosition !== null).length;
}

/** Index of the first un-raced round, or -1 when the season is complete. */
export function nextRoundIndex(season: ChampionshipSeason): number {
  return season.rounds.findIndex((round) => round.playerPosition === null);
}

export function isSeasonComplete(season: ChampionshipSeason): boolean {
  return season.rounds.length > 0 && nextRoundIndex(season) === -1;
}

/**
 * Returns a new season with the round's result filled in (immutable, so the
 * caller can hold it in React state). Out-of-range round indices are a no-op
 * - a hand-edited `?champ=` URL can't corrupt the season.
 */
export function recordRoundResult(
  season: ChampionshipSeason,
  roundIndex: number,
  playerPosition: number
): ChampionshipSeason {
  if (roundIndex < 0 || roundIndex >= season.rounds.length) return season;
  if (!Number.isInteger(playerPosition) || playerPosition < 1) return season;
  const rounds = season.rounds.map((round, i) =>
    i === roundIndex ? { ...round, playerPosition } : round
  );
  return { ...season, rounds };
}

/**
 * Records a weekend's qualifying outcome (the player's grid spot). Same
 * immutability and bounds discipline as recordRoundResult - and re-running
 * qualifying simply overwrites, so a bad session can be re-driven before
 * the race.
 */
export function recordQualiResult(
  season: ChampionshipSeason,
  roundIndex: number,
  qualiSpot: 1 | 2
): ChampionshipSeason {
  if (roundIndex < 0 || roundIndex >= season.rounds.length) return season;
  if (qualiSpot !== 1 && qualiSpot !== 2) return season;
  const rounds = season.rounds.map((round, i) =>
    i === roundIndex ? { ...round, qualiSpot } : round
  );
  return { ...season, rounds };
}

/**
 * Where a championship weekend stands: practice is always available and
 * never required, qualifying gates the race, and a raced round is done.
 * Returns null for an out-of-range round (stale links degrade to nothing
 * to show, not a crash).
 */
export function weekendStage(
  season: ChampionshipSeason,
  roundIndex: number
): "qualifying" | "race" | "done" | null {
  const round = season.rounds[roundIndex];
  if (!round) return null;
  if (round.playerPosition !== null) return "done";
  // Loose check: seasons saved before qualiSpot existed carry undefined.
  if (round.qualiSpot == null) return "qualifying";
  return "race";
}

export interface ChampionshipStandings {
  playerPoints: number;
  aiPoints: number;
  playerWins: number;
  aiWins: number;
  completedRounds: number;
  totalRounds: number;
}

export function computeStandings(season: ChampionshipSeason): ChampionshipStandings {
  let playerPoints = 0;
  let aiPoints = 0;
  let playerWins = 0;
  let aiWins = 0;
  let completed = 0;
  for (const round of season.rounds) {
    if (round.playerPosition === null) continue;
    completed += 1;
    playerPoints += pointsForPosition(round.playerPosition);
    // Single opponent: whoever isn't the player (see the field-size note above).
    const aiPosition = round.playerPosition === 1 ? 2 : 1;
    aiPoints += pointsForPosition(aiPosition);
    if (round.playerPosition === 1) playerWins += 1;
    else aiWins += 1;
  }
  return {
    playerPoints,
    aiPoints,
    playerWins,
    aiWins,
    completedRounds: completed,
    totalRounds: season.rounds.length,
  };
}

/** Champion once the season is complete, null while rounds remain. */
export function seasonChampion(
  season: ChampionshipSeason
): "player" | "ai" | "tie" | null {
  if (!isSeasonComplete(season)) return null;
  const { playerPoints, aiPoints } = computeStandings(season);
  if (playerPoints > aiPoints) return "player";
  if (aiPoints > playerPoints) return "ai";
  return "tie";
}

/**
 * Resolves the race page's `?champ=` value to a round index - a non-negative
 * integer, or null (not a championship race). Deliberately does not check the
 * round against a season here: the season lives in IndexedDB and is loaded by
 * the writer, which no-ops on an out-of-range index (see recordRoundResult).
 */
export function parseChampRound(raw: string | null): number | null {
  if (raw === null) return null;
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Shape guard for save import (see lib/persistence/saveBundle.ts). */
export function isChampionshipSeason(value: unknown): value is ChampionshipSeason {
  if (typeof value !== "object" || value === null) return false;
  const season = value as {
    schemaVersion?: unknown;
    createdAt?: unknown;
    rounds?: unknown;
  };
  if (season.schemaVersion !== 1) return false;
  if (typeof season.createdAt !== "string") return false;
  if (!Array.isArray(season.rounds)) return false;
  return season.rounds.every((round) => {
    if (typeof round !== "object" || round === null) return false;
    const { trackId, playerPosition, qualiSpot } = round as {
      trackId?: unknown;
      playerPosition?: unknown;
      qualiSpot?: unknown;
    };
    if (typeof trackId !== "string" || !isKnownTrackId(trackId)) return false;
    // qualiSpot is newer than some saved seasons - absent counts as
    // unqualified (the weekend flow treats it as "qualifying next").
    if (
      qualiSpot !== undefined &&
      qualiSpot !== null &&
      qualiSpot !== 1 &&
      qualiSpot !== 2
    ) {
      return false;
    }
    return (
      playerPosition === null ||
      (typeof playerPosition === "number" &&
        Number.isInteger(playerPosition) &&
        playerPosition >= 1)
    );
  });
}
