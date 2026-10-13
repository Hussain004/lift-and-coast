// One record per finished race, kept locally so the Garage can show a career
// (starts, wins, podiums...) and milestones can be derived from it. Pure
// types and guards; storage is lib/persistence/raceHistory.ts.

export interface RaceHistoryRecord {
  schemaVersion: 1;
  /** ISO timestamp the race ended. */
  at: string;
  trackId: string;
  laps: number;
  rivals: number;
  aiLevel: string;
  teamId: string;
  driverCode: string;
  /** Final classified position (1 = win). */
  finish: number;
  points: number;
  fastestLap: boolean;
  penaltySeconds: number;
  disqualified: boolean;
  /** Championship round index when the race scored one; null for an exhibition. */
  champRound: number | null;
  sprint: boolean;
}

/** Oldest records are dropped past this, so the store never grows without bound. */
export const MAX_RACE_HISTORY = 500;

export function isRaceHistoryRecord(value: unknown): value is RaceHistoryRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const int = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;
  return (
    r.schemaVersion === 1 &&
    typeof r.at === "string" &&
    typeof r.trackId === "string" &&
    int(r.laps, 1) &&
    int(r.rivals, 0) &&
    typeof r.aiLevel === "string" &&
    typeof r.teamId === "string" &&
    typeof r.driverCode === "string" &&
    int(r.finish, 1) &&
    typeof r.points === "number" &&
    typeof r.fastestLap === "boolean" &&
    typeof r.penaltySeconds === "number" &&
    typeof r.disqualified === "boolean" &&
    (r.champRound === null || int(r.champRound, 0)) &&
    typeof r.sprint === "boolean"
  );
}

/** Newest-first list trimmed to the cap. */
export function capHistory(records: readonly RaceHistoryRecord[]): RaceHistoryRecord[] {
  return [...records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, MAX_RACE_HISTORY);
}
