import type { TrackLimitStage } from "./trackLimitSequence";

export interface RaceProgress {
  lapCount: number;
  /** Arc-length distance from the start/finish line, meters - resets to ~0 each lap. */
  progressMeters: number;
  /** Signed forward speed when this snapshot was written, m/s - feeds the
   * timing tower's gap seconds (see renderTowerHtml). Optional so older
   * callers and tests keep compiling; missing reads as stopped. */
  speedMs?: number;
  /** Last completed lap, when one exists. */
  lastLapSeconds?: number | null;
  /** Best completed lap, when one exists. */
  bestLapSeconds?: number | null;
  /** Current race-control track-limits stage, if any. */
  trackLimitStage?: TrackLimitStage;
  /** One-based warning episode while `trackLimitStage` is "warning". */
  trackLimitWarningNumber?: number | null;
}

/**
 * Shared, mutable (not React state - written every physics tick by every
 * car). Index 0 of `opponents` is the first rival, in roster order - see
 * resolveFieldRoster.
 */
export interface RaceState {
  player: RaceProgress;
  opponents: RaceProgress[];
}

export function createRaceState(opponents = 0): RaceState {
  return {
    player: { lapCount: 0, progressMeters: 0, speedMs: 0 },
    opponents: Array.from({ length: opponents }, () => ({ lapCount: 0, progressMeters: 0, speedMs: 0 })),
  };
}

function totalDistance(progress: RaceProgress, trackLengthMeters: number): number {
  return progress.lapCount * trackLengthMeters + progress.progressMeters;
}

/**
 * Plan section 7 (Grand Prix mode): who's ahead, for a live position
 * indicator. lapCount*trackLength + progressMeters is a monotonically
 * increasing "total distance covered" for each car - comparing that
 * directly (not lap count alone) correctly ranks two cars on the same lap
 * by how far around it they've gotten.
 */
export function computeRacePosition(
  player: RaceProgress,
  ai: RaceProgress,
  trackLengthMeters: number
): 1 | 2 {
  return totalDistance(player, trackLengthMeters) >= totalDistance(ai, trackLengthMeters) ? 1 : 2;
}

/**
 * Full-field version: finishing position (1-based) for the player (index
 * 0) followed by each opponent in order. Ties break toward the lower
 * index, so the player wins exact ties - the same convention as
 * computeRacePosition's `>=` above.
 */
export function computeRacePositions(
  progresses: readonly RaceProgress[],
  trackLengthMeters: number
): number[] {
  const order = progresses
    .map((progress, index) => ({ index, total: totalDistance(progress, trackLengthMeters) }))
    .sort((a, b) => b.total - a.total || a.index - b.index);
  const positions = new Array<number>(progresses.length);
  order.forEach((entry, rank) => {
    positions[entry.index] = rank + 1;
  });
  return positions;
}

export interface TowerDriver {
  code: string;
  color: string;
  number?: number | null;
  name?: string | null;
  teamId?: string | null;
}

export interface TowerEntry extends TowerDriver {
  /** Finishing/live position (1-based), from computeRacePositions. */
  position: number;
  /** Seconds behind the leader, or null for the leader itself. */
  gapSeconds: number | null;
  /** Seconds behind the car immediately ahead, or null for the leader. */
  intervalSeconds: number | null;
  /** Full laps behind the leader (from distance, not pace). */
  lapsDown: number;
  /** Full laps between this car and the car immediately ahead. */
  intervalLapsDown: number;
  lastLapSeconds: number | null;
  bestLapSeconds: number | null;
  isFastestLap: boolean;
  trackLimitStage: TrackLimitStage | null;
  trackLimitWarningNumber: number | null;
  isPlayer: boolean;
}

/**
 * Orders tower entries the broadcast way: by finishing position, the
 * leader first. Pure over data (no DOM) so the tower is unit-testable;
 * the race loop renders the returned order into tower HTML.
 */
export function orderTowerEntries(entries: readonly TowerEntry[]): TowerEntry[] {
  return [...entries].sort((a, b) => a.position - b.position);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeColor(color: string): string {
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#888888";
}

/**
 * Renders a broadcast-style timing row. The leader's first timing column is
 * LEADER; followers show interval to the car ahead, while the separate gap
 * column remains leader-relative. Last/best laps and race-control status
 * are retained in the data model for consumers such as multiplayer, while
 * the compact broadcast renderer intentionally exposes only INT and GAP.
 */
export function renderTowerHtml(entries: readonly TowerEntry[]): string {
  return orderTowerEntries(entries)
    .map((entry) => {
      const gap =
        entry.gapSeconds === null
          ? "LEADER"
          : entry.lapsDown >= 1
            ? entry.lapsDown === 1
              ? "+1 LAP"
              : `+${entry.lapsDown} LAPS`
            : `+${entry.gapSeconds.toFixed(1)}`;
      const interval =
        entry.intervalSeconds === null
          ? "LEADER"
          : entry.intervalLapsDown >= 1
            ? entry.intervalLapsDown === 1
              ? "+1 LAP"
              : `+${entry.intervalLapsDown} LAPS`
            : `+${entry.intervalSeconds.toFixed(1)}`;
      const code = escapeHtml(entry.code);
      return (
        `<div class="tower-row${entry.isPlayer ? " tower-row-you" : ""}" data-code="${code}">` +
        `<span class="tower-pos">P${entry.position}</span>` +
        `<span class="tower-driver"><span class="code-chip" style="background:${safeColor(entry.color)}">${code}</span></span>` +
        `<span class="tower-interval">${interval}</span>` +
        `<span class="tower-gap">${gap}</span></div>`
      );
    })
    .join("");
}

/**
 * Pairs each rival with its live progress for the tower builders below -
 * shared by Car.tsx (live HUD) and NetHost (broadcast), so both rank the
 * same field the same way. Optional driver metadata is only copied when a
 * caller supplied it, preserving the compact shape used by older callers.
 */
export type TowerOpponent = TowerDriver & { progress: RaceProgress };

export function towerOpponents(
  rivals: readonly TowerDriver[],
  opponents: readonly (RaceProgress | undefined)[]
): TowerOpponent[] {
  return rivals.map((rival, k) => {
    const entry: TowerDriver & { progress: RaceProgress } = {
      code: rival.code,
      color: rival.color,
      progress: opponents[k] ?? { lapCount: 0, progressMeters: 0 },
    };
    if (rival.number !== undefined) entry.number = rival.number;
    if (rival.name !== undefined) entry.name = rival.name;
    if (rival.teamId !== undefined) entry.teamId = rival.teamId;
    return entry;
  });
}

/**
 * Builds tower entries (positions, intervals/gaps, lap fields, fastest-lap
 * highlight, and race-control status) for the player plus every opponent
 * from live progress. Gap/interval are display estimates based on the
 * relevant cars' speeds; positions always come from distance.
 */
export function buildTowerEntries(
  player: TowerDriver & { progress: RaceProgress },
  opponents: readonly (TowerDriver & { progress: RaceProgress })[],
  trackLengthMeters: number
): TowerEntry[] {
  const drivers = [player, ...opponents];
  const progresses = drivers.map((entry) => entry.progress);
  const safeTrackLength = Math.max(1, trackLengthMeters);
  const positions = computeRacePositions(progresses, safeTrackLength);
  const leaderTotal = Math.max(...progresses.map((p) => totalDistance(p, safeTrackLength)));
  const bestLap = progresses.reduce<number | null>((best, progress) => {
    const value = progress.bestLapSeconds;
    return value !== null && value !== undefined && Number.isFinite(value) && (best === null || value < best)
      ? value
      : best;
  }, null);

  const entries = drivers.map((driver, index) => {
    const progress = driver.progress;
    const total = totalDistance(progress, safeTrackLength);
    const position = positions[index];
    const gapMeters = Math.max(0, leaderTotal - total);
    const leaderSpeedMs = Math.max(5, Math.abs(progresses[positions.indexOf(1)]?.speedMs ?? 30));
    const speedMs = Math.max(5, (Math.abs(progress.speedMs ?? 30) + leaderSpeedMs) / 2);
    const isFastestLap = bestLap !== null && progress.bestLapSeconds === bestLap;
    return {
      ...driver,
      position,
      gapSeconds: position === 1 ? null : gapMeters / speedMs,
      intervalSeconds: null as number | null,
      lapsDown: Math.floor(gapMeters / safeTrackLength),
      intervalLapsDown: 0 as number,
      lastLapSeconds: progress.lastLapSeconds ?? null,
      bestLapSeconds: progress.bestLapSeconds ?? null,
      isFastestLap,
      trackLimitStage: progress.trackLimitStage ?? null,
      trackLimitWarningNumber: progress.trackLimitWarningNumber ?? null,
      isPlayer: index === 0,
    } satisfies TowerEntry;
  });

  const ordered = entries.slice().sort((a, b) => a.position - b.position);
  for (let i = 1; i < ordered.length; i++) {
    const ahead = ordered[i - 1];
    const entry = ordered[i];
    const aheadProgress = progresses[entries.indexOf(ahead)];
    const entryProgress = progresses[entries.indexOf(entry)];
    const meters = Math.max(
      0,
      totalDistance(aheadProgress, safeTrackLength) - totalDistance(entryProgress, safeTrackLength)
    );
    const effectiveSpeed = Math.max(
      5,
      (Math.abs(aheadProgress.speedMs ?? 0) + Math.abs(entryProgress.speedMs ?? 0)) / 2
    );
    entry.intervalSeconds = meters / effectiveSpeed;
    entry.intervalLapsDown = Math.floor(meters / safeTrackLength);
  }
  return ordered;
}
