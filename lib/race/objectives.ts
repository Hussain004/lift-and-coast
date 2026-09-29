// Team objectives for a championship round, and the reputation they build.
// Pure and derived: nothing is stored beyond the round results the season
// already keeps, so an old save gets its reputation for free and no AI or
// physics is touched. The team you drive for sets the ask (a front-running
// team wants podiums, a back-marker wants points), and every second round
// it is the same for every team: beat your team-mate.
import type { ChampionshipRound, ChampionshipSeason, RoundResultRow } from "./championship";

export type ObjectiveKind = "podium" | "top-8" | "points" | "beat-teammate";

export interface Objective {
  kind: ObjectiveKind;
  label: string;
}

const TIER_ONE = new Set(["mercedes", "red-bull", "ferrari", "mclaren"]);
const TIER_TWO = new Set(["aston-martin", "alpine", "williams"]);

const LABELS: Record<ObjectiveKind, string> = {
  podium: "Finish on the podium",
  "top-8": "Finish in the top 8",
  points: "Score points (top 10)",
  "beat-teammate": "Beat your team-mate",
};

export function objectiveFor(teamId: string | null, roundIndex: number): Objective {
  let kind: ObjectiveKind = TIER_ONE.has(teamId ?? "") ? "podium" : TIER_TWO.has(teamId ?? "") ? "top-8" : "points";
  if (roundIndex % 2 === 1) kind = "beat-teammate";
  return { kind, label: LABELS[kind] };
}

/** True/false once the round is raced; null when there is nothing to judge it on. */
export function objectiveMet(objective: Objective, round: ChampionshipRound): boolean | null {
  if (round.playerPosition === null) return null;
  const position = round.playerPosition;
  if (objective.kind === "beat-teammate") {
    const rows: RoundResultRow[] = round.result ?? [];
    const me = rows.find((r) => r.isPlayer);
    const mate = me ? rows.find((r) => !r.isPlayer && r.teamId !== null && r.teamId === me.teamId) : undefined;
    if (!me || !mate) return position <= 10; // no team-mate on record: fall back to the points ask
    return me.position < mate.position;
  }
  return position <= (objective.kind === "podium" ? 3 : objective.kind === "top-8" ? 8 : 10);
}

/** The team the player raced for in a round (from its recorded result), if known. */
function raceTeam(round: ChampionshipRound): string | null {
  return round.result?.find((r) => r.isPlayer)?.teamId ?? null;
}

export const REPUTATION_START = 30;
const MET_GAIN = 8;
const MISSED_LOSS = 4;

export interface SeasonObjectives {
  /** Per round: met / missed / null (not raced). */
  outcomes: (boolean | null)[];
  /** 0-100. */
  reputation: number;
}

/** Judges every raced round against the objective its team set, and totals the reputation. */
export function seasonObjectives(season: ChampionshipSeason, currentTeamId: string | null): SeasonObjectives {
  let reputation = REPUTATION_START;
  const outcomes = season.rounds.map((round, i) => {
    const met = objectiveMet(objectiveFor(raceTeam(round) ?? currentTeamId, i), round);
    if (met !== null) reputation += met ? MET_GAIN : -MISSED_LOSS;
    return met;
  });
  return { outcomes, reputation: Math.max(0, Math.min(100, reputation)) };
}

export function reputationTitle(reputation: number): string {
  if (reputation >= 80) return "Team leader";
  if (reputation >= 55) return "Rising star";
  if (reputation >= 30) return "Solid pro";
  return "Under review";
}
