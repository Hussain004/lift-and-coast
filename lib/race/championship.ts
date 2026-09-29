// Plan sections 7, 8 and 10: Championship mode - a season run across the
// registered circuits with F1-style points, persisted in IndexedDB (see
// lib/persistence/championship.ts) and shown on the home screen. Pure logic
// only (no storage, no React) so the points/standings bookkeeping is
// unit-testable without a browser.
//
// Field size: this build races the player against up to 19 verified AI
// opponents (see resolveFieldRoster), so a round is a full-field result.
// The points table below is the full F1-style list (25-18-15-...) and the
// standings' "AI" row follows the best-finishing rival each round - the
// car that actually contested the win - which is exactly what the old
// single-opponent math computed, generalized: best rival is P2 when the
// player wins, P1 otherwise.
import { isKnownTrackId } from "../tracks/registry";
import { MAX_FIELD_SIZE } from "./sessionSetup";

/** Plan section 7: F1-style points (25-18-15-...). */
export const CHAMPIONSHIP_POINTS: readonly number[] = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export function pointsForPosition(position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return CHAMPIONSHIP_POINTS[position - 1] ?? 0;
}

/** Sprint points: the top eight, 8 down to 1. */
export const SPRINT_POINTS: readonly number[] = [8, 7, 6, 5, 4, 3, 2, 1];
export const SPRINT_LAPS = 2;

export function sprintPointsForPosition(position: number): number {
  if (!Number.isInteger(position) || position < 1) return 0;
  return SPRINT_POINTS[position - 1] ?? 0;
}

/** One point for the fastest lap, if the driver finished in the top ten. */
export const FASTEST_LAP_POINT = 1;
export function fastestLapPoint(position: number, hasFastestLap: boolean): number {
  return hasFastestLap && position >= 1 && position <= 10 ? FASTEST_LAP_POINT : 0;
}

/** One car's line in a raced round's classification. */
export interface RoundResultRow {
  code: string;
  name: string | null;
  teamId: string | null;
  position: number;
  points: number;
  isPlayer: boolean;
}

export interface ChampionshipRound {
  trackId: string;
  /**
   * The whole field's classification, when the round was raced on a build
   * that records it. Optional so seasons saved before it existed still load
   * (their rounds only know the player's position).
   */
  result?: RoundResultRow[];
  /** Player's finishing position; null until the round has been raced. */
  playerPosition: number | null;
  /**
   * Player's grid spot from this weekend's qualifying (1 = pole); null
   * until qualified. The race is only offered once this is set - a
   * championship weekend runs practice (optional) -> qualifying -> race.
   */
  qualiSpot: number | null;
  /** Practice programmes completed this weekend (see practiceProgrammes.ts). */
  practice?: Partial<Record<"acclimatisation" | "consistency" | "pace", true>>;
  /** The sprint's classification, once driven (sprint weekends only). */
  sprint?: { position: number; result: RoundResultRow[] };
}

/** Which sessions a weekend runs: everything, skip practice, or just the race. */
export type WeekendFormat = "full" | "quali-race" | "race";

export const WEEKEND_FORMATS: { id: WeekendFormat; label: string; blurb: string }[] = [
  { id: "full", label: "Full weekend", blurb: "practice, qualifying, race" },
  { id: "quali-race", label: "Quali + race", blurb: "skip practice" },
  { id: "race", label: "Race only", blurb: "straight to the grid" },
];

/** Every fourth round of a sprint season is a sprint weekend. */
export const SPRINT_EVERY = 4;

export interface ChampionshipSeason {
  schemaVersion: 1;
  createdAt: string;
  rounds: ChampionshipRound[];
  /** Absent on older saves: a full weekend, no sprints. */
  format?: WeekendFormat;
  sprints?: boolean;
}

export function createSeason(
  trackIds: readonly string[],
  createdAt: string,
  options: { format?: WeekendFormat; sprints?: boolean } = {}
): ChampionshipSeason {
  return {
    schemaVersion: 1,
    createdAt,
    rounds: trackIds.map((trackId) => ({ trackId, playerPosition: null, qualiSpot: null })),
    ...(options.format && options.format !== "full" ? { format: options.format } : {}),
    ...(options.sprints ? { sprints: true } : {}),
  };
}

export function isSprintRound(season: ChampionshipSeason, roundIndex: number): boolean {
  return !!season.sprints && (roundIndex + 1) % SPRINT_EVERY === 0;
}

/** Records the sprint's classification for a round (bad indices and non-sprint rounds are no-ops). */
export function recordSprintResult(
  season: ChampionshipSeason,
  roundIndex: number,
  playerPosition: number,
  result: readonly RoundResultRow[]
): ChampionshipSeason {
  if (!isSprintRound(season, roundIndex) || !Number.isInteger(playerPosition) || playerPosition < 1) return season;
  const rounds = season.rounds.map((round, i) =>
    i === roundIndex ? { ...round, sprint: { position: playerPosition, result: [...result] } } : round
  );
  return { ...season, rounds };
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
  playerPosition: number,
  result?: readonly RoundResultRow[]
): ChampionshipSeason {
  if (roundIndex < 0 || roundIndex >= season.rounds.length) return season;
  if (!Number.isInteger(playerPosition) || playerPosition < 1) return season;
  const rounds = season.rounds.map((round, i) =>
    i === roundIndex ? { ...round, playerPosition, ...(result ? { result: [...result] } : {}) } : round
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
  qualiSpot: number
): ChampionshipSeason {
  if (roundIndex < 0 || roundIndex >= season.rounds.length) return season;
  if (!Number.isInteger(qualiSpot) || qualiSpot < 1 || qualiSpot > MAX_FIELD_SIZE) return season;
  const rounds = season.rounds.map((round, i) =>
    i === roundIndex ? { ...round, qualiSpot } : round
  );
  return { ...season, rounds };
}

/** Marks a practice programme done for a round (idempotent; bad indices are a no-op). */
export function recordPracticeProgramme(
  season: ChampionshipSeason,
  roundIndex: number,
  programme: "acclimatisation" | "consistency" | "pace"
): ChampionshipSeason {
  const round = season.rounds[roundIndex];
  if (!round || round.practice?.[programme]) return season;
  const rounds = season.rounds.map((r, i) => (i === roundIndex ? { ...r, practice: { ...r.practice, [programme]: true as const } } : r));
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
): "qualifying" | "sprint" | "race" | "done" | null {
  const round = season.rounds[roundIndex];
  if (!round) return null;
  if (round.playerPosition !== null) return "done";
  // Race-only weekends go straight to the grid.
  if (season.format === "race") return "race";
  // Loose check: seasons saved before qualiSpot existed carry undefined.
  if (round.qualiSpot == null) return "qualifying";
  if (isSprintRound(season, roundIndex) && !round.sprint) return "sprint";
  return "race";
}

/** Stable key for the player's standings row, whichever driver they drove. */
export const PLAYER_KEY = "__player__";

export interface DriverStanding {
  key: string;
  code: string;
  name: string | null;
  teamId: string | null;
  isPlayer: boolean;
  points: number;
  wins: number;
  podiums: number;
  /** Finishing position per round, null where not classified / not raced. */
  finishes: (number | null)[];
}

export interface TeamStanding {
  teamId: string;
  points: number;
  wins: number;
}

function byPoints<T extends { points: number; wins: number }>(a: T, b: T): number {
  return b.points - a.points || b.wins - a.wins;
}

/**
 * The drivers' championship, every car on the grid. Rounds raced before
 * full results were recorded still score the player (their position is all
 * that was saved). The player is keyed by PLAYER_KEY so their points stay in
 * one row even if they switch driver mid-season.
 */
export function computeDriverStandings(season: ChampionshipSeason): DriverStanding[] {
  const rows = new Map<string, DriverStanding>();
  const row = (key: string, init: Omit<DriverStanding, "points" | "wins" | "podiums" | "finishes">) => {
    let r = rows.get(key);
    if (!r) {
      r = { ...init, points: 0, wins: 0, podiums: 0, finishes: season.rounds.map(() => null) };
      rows.set(key, r);
    }
    return r;
  };
  const score = (r: DriverStanding, position: number, points: number, round: number) => {
    r.points += points;
    if (position === 1) r.wins += 1;
    if (position <= 3) r.podiums += 1;
    r.finishes[round] = position;
  };
  season.rounds.forEach((round, i) => {
    // Sprint points count for the tables (not for wins, podiums or the form line).
    for (const entry of round.sprint?.result ?? []) {
      const key = entry.isPlayer ? PLAYER_KEY : entry.code;
      const r = row(key, { key, code: entry.code, name: entry.name, teamId: entry.teamId, isPlayer: entry.isPlayer });
      if (entry.isPlayer) Object.assign(r, { code: entry.code, name: entry.name, teamId: entry.teamId });
      r.points += entry.points;
    }
    if (round.playerPosition === null) return;
    if (round.result && round.result.length > 0) {
      for (const entry of round.result) {
        const key = entry.isPlayer ? PLAYER_KEY : entry.code;
        const r = row(key, { key, code: entry.code, name: entry.name, teamId: entry.teamId, isPlayer: entry.isPlayer });
        // The player's latest driver/team wins, so the table shows who they are now.
        if (entry.isPlayer) Object.assign(r, { code: entry.code, name: entry.name, teamId: entry.teamId });
        score(r, entry.position, entry.points, i);
      }
    } else {
      const r = row(PLAYER_KEY, { key: PLAYER_KEY, code: "YOU", name: null, teamId: null, isPlayer: true });
      score(r, round.playerPosition, pointsForPosition(round.playerPosition), i);
    }
  });
  return [...rows.values()].sort(byPoints);
}

/** The constructors' championship: each team's drivers' points combined. */
export function computeTeamStandings(season: ChampionshipSeason): TeamStanding[] {
  const teams = new Map<string, TeamStanding>();
  for (const driver of computeDriverStandings(season)) {
    if (!driver.teamId) continue;
    const t = teams.get(driver.teamId) ?? { teamId: driver.teamId, points: 0, wins: 0 };
    t.points += driver.points;
    t.wins += driver.wins;
    teams.set(driver.teamId, t);
  }
  return [...teams.values()].sort(byPoints);
}

/** The champion once the season is complete, null while rounds remain. */
export function seasonChampion(season: ChampionshipSeason): DriverStanding | null {
  if (!isSeasonComplete(season)) return null;
  return computeDriverStandings(season)[0] ?? null;
}

/**
 * Season lengths offered when starting a championship. The 2026 calendar is
 * the real round order; "all" appends the historic circuits after it.
 */
export const CALENDAR_2026 = [
  "melbourne", "shanghai", "suzuka", "bahrain", "jeddah", "miami", "montreal", "monaco",
  "barcelona", "spielberg", "silverstone", "spa", "budapest", "zandvoort", "monza", "madrid",
  "baku", "singapore", "cota", "mexico", "interlagos", "lasvegas", "lusail", "yasmarina",
] as const;

export type SeasonLength = "short" | "calendar" | "all";

export const SEASON_LENGTHS: { id: SeasonLength; label: string; blurb: string }[] = [
  { id: "short", label: "Short", blurb: "6 classic rounds" },
  { id: "calendar", label: "2026 Calendar", blurb: "24 rounds in real order" },
  { id: "all", label: "Every Circuit", blurb: "the calendar plus historic tracks" },
];

const SHORT_SEASON = ["melbourne", "suzuka", "monaco", "silverstone", "spa", "monza"];

/** The rounds for a season length, keeping only circuits that exist. */
export function seasonTrackIds(length: SeasonLength, known: readonly string[]): string[] {
  const has = new Set(known);
  const calendar = CALENDAR_2026.filter((id) => has.has(id));
  if (length === "short") return SHORT_SEASON.filter((id) => has.has(id));
  if (length === "calendar") return calendar;
  return [...calendar, ...known.filter((id) => !calendar.includes(id as (typeof CALENDAR_2026)[number]))];
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

function isRoundResultRow(value: unknown): value is RoundResultRow {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.code === "string" &&
    r.code.length <= 8 &&
    (r.name === null || typeof r.name === "string") &&
    (r.teamId === null || typeof r.teamId === "string") &&
    typeof r.position === "number" &&
    Number.isInteger(r.position) &&
    r.position >= 1 &&
    typeof r.points === "number" &&
    Number.isFinite(r.points) &&
    r.points >= 0 &&
    typeof r.isPlayer === "boolean"
  );
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
    const { trackId, playerPosition, qualiSpot, result } = round as {
      trackId?: unknown;
      playerPosition?: unknown;
      qualiSpot?: unknown;
      result?: unknown;
    };
    if (typeof trackId !== "string" || !isKnownTrackId(trackId)) return false;
    if (result !== undefined && !(Array.isArray(result) && result.every(isRoundResultRow))) return false;
    const sprint = (round as { sprint?: unknown }).sprint;
    if (sprint !== undefined) {
      const sp = sprint as { position?: unknown; result?: unknown } | null;
      if (typeof sp !== "object" || sp === null) return false;
      if (typeof sp.position !== "number" || !Array.isArray(sp.result) || !sp.result.every(isRoundResultRow)) return false;
    }
    // qualiSpot is newer than some saved seasons - absent counts as
    // unqualified (the weekend flow treats it as "qualifying next").
    if (
      qualiSpot !== undefined &&
      qualiSpot !== null &&
      (typeof qualiSpot !== "number" ||
        !Number.isInteger(qualiSpot) ||
        qualiSpot < 1 ||
        qualiSpot > MAX_FIELD_SIZE)
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
