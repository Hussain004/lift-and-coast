// Career numbers and milestones, all DERIVED from the race history: nothing
// extra is stored, so an old player's earlier races count the moment this
// ships, and a milestone can never disagree with the records it came from.

import type { RaceHistoryRecord } from "./raceHistory";

export interface DriverStats {
  starts: number;
  wins: number;
  podiums: number;
  pointsFinishes: number;
  fastestLaps: number;
  points: number;
  /** Best finish per circuit id. */
  bestByTrack: Record<string, number>;
  circuitsRaced: number;
}

export function computeStats(history: readonly RaceHistoryRecord[]): DriverStats {
  const stats: DriverStats = {
    starts: 0,
    wins: 0,
    podiums: 0,
    pointsFinishes: 0,
    fastestLaps: 0,
    points: 0,
    bestByTrack: {},
    circuitsRaced: 0,
  };
  for (const r of history) {
    stats.starts += 1;
    if (r.disqualified) continue;
    if (r.finish === 1) stats.wins += 1;
    if (r.finish <= 3) stats.podiums += 1;
    if (r.finish <= 10) stats.pointsFinishes += 1;
    if (r.fastestLap) stats.fastestLaps += 1;
    stats.points += r.points;
    const best = stats.bestByTrack[r.trackId];
    if (best === undefined || r.finish < best) stats.bestByTrack[r.trackId] = r.finish;
  }
  stats.circuitsRaced = new Set(history.map((r) => r.trackId)).size;
  return stats;
}

export interface Milestone {
  id: string;
  label: string;
  blurb: string;
}

type History = readonly RaceHistoryRecord[];
type Check = (history: History, stats: DriverStats) => boolean;

const clean = (r: RaceHistoryRecord) => !r.disqualified;
const wins = (h: History) => h.filter((r) => clean(r) && r.finish === 1);
const podiumTracks = (h: History) => new Set(h.filter((r) => clean(r) && r.finish <= 3).map((r) => r.trackId));

/** Chronological order is what "in a row" means, so sort a copy first. */
function longestWinStreak(h: History): number {
  const ordered = [...h].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  let best = 0;
  let run = 0;
  for (const r of ordered) {
    run = clean(r) && r.finish === 1 ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

const MILESTONE_CHECKS: [Milestone, Check][] = [
  [{ id: "first-start", label: "On the grid", blurb: "Finish your first race" }, (_h, s) => s.starts >= 1],
  [{ id: "first-points", label: "In the points", blurb: "Finish in the top ten" }, (_h, s) => s.pointsFinishes >= 1],
  [{ id: "first-podium", label: "Champagne", blurb: "Take a podium" }, (_h, s) => s.podiums >= 1],
  [{ id: "first-win", label: "Winner", blurb: "Win a race" }, (_h, s) => s.wins >= 1],
  [{ id: "wins-5", label: "Habit forming", blurb: "Win 5 races" }, (_h, s) => s.wins >= 5],
  [{ id: "wins-25", label: "Dominant", blurb: "Win 25 races" }, (_h, s) => s.wins >= 25],
  [{ id: "starts-10", label: "Regular", blurb: "Finish 10 races" }, (_h, s) => s.starts >= 10],
  [{ id: "starts-50", label: "Veteran", blurb: "Finish 50 races" }, (_h, s) => s.starts >= 50],
  [{ id: "fastest-lap", label: "Purple sector", blurb: "Set the fastest lap of a race" }, (_h, s) => s.fastestLaps >= 1],
  [
    { id: "full-grid-win", label: "Beat them all", blurb: "Win against a full 20-car grid" },
    (h) => wins(h).some((r) => r.rivals >= 19),
  ],
  [
    { id: "ace-win", label: "Beat the best", blurb: "Win on Ace difficulty" },
    (h) => wins(h).some((r) => r.aiLevel === "ace"),
  ],
  [
    { id: "ace-podium", label: "Ace contender", blurb: "Podium on Ace difficulty" },
    (h) => h.some((r) => clean(r) && r.finish <= 3 && r.aiLevel === "ace"),
  ],
  [
    { id: "clean-race", label: "Clean sheet", blurb: "Win a race of 3+ laps without a penalty" },
    (h) => wins(h).some((r) => r.penaltySeconds === 0 && r.laps >= 3),
  ],
  [
    { id: "distance", label: "Going the distance", blurb: "Win a race of 10 or more laps" },
    (h) => wins(h).some((r) => r.laps >= 10),
  ],
  [
    { id: "hat-trick", label: "Hat-trick", blurb: "Win three races in a row" },
    (h) => longestWinStreak(h) >= 3,
  ],
  [
    { id: "five-winners-circle", label: "World tour", blurb: "Win at 5 different circuits" },
    (h) => new Set(wins(h).map((r) => r.trackId)).size >= 5,
  ],
  [
    { id: "podium-tour", label: "Podium tour", blurb: "Podium at 5 different circuits" },
    (h) => podiumTracks(h).size >= 5,
  ],
  [
    { id: "circuits-10", label: "Frequent flyer", blurb: "Race at 10 different circuits" },
    (_h, s) => s.circuitsRaced >= 10,
  ],
  [
    { id: "champ-round-win", label: "Title contender", blurb: "Win a championship round" },
    (h) => wins(h).some((r) => r.champRound !== null && !r.sprint),
  ],
  [
    { id: "sprint-win", label: "Sprinter", blurb: "Win a sprint race" },
    (h) => wins(h).some((r) => r.sprint),
  ],
];

export const MILESTONES: Milestone[] = MILESTONE_CHECKS.map(([m]) => m);

/** Ids of every milestone the history has earned. */
export function earnedMilestones(history: History): Set<string> {
  const stats = computeStats(history);
  return new Set(MILESTONE_CHECKS.filter(([, check]) => check(history, stats)).map(([m]) => m.id));
}

/** Milestones a new record earns that the history before it did not. */
export function newlyEarned(before: History, added: RaceHistoryRecord): Milestone[] {
  const had = earnedMilestones(before);
  const now = earnedMilestones([...before, added]);
  return MILESTONES.filter((m) => now.has(m.id) && !had.has(m.id));
}
