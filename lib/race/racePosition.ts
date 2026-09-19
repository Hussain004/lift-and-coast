export interface RaceProgress {
  lapCount: number;
  /** Arc-length distance from the start/finish line, meters - resets to ~0 each lap. */
  progressMeters: number;
  /**
   * Signed forward speed when this snapshot was written, m/s - feeds the
   * timing tower's gap seconds (see renderTowerHtml). Optional so older
   * callers and tests keep compiling; missing reads as stopped.
   */
  speedMs?: number;
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

export interface TowerEntry {
  /** FIA-style code shown on the chip. */
  code: string;
  /** Livery color for the chip and minimap dot. */
  color: string;
  /** Finishing position (1-based), from computeRacePositions. */
  position: number;
  /**
   * Seconds behind the leader (interval-style gap), or null for the
   * leader itself.
   */
  gapSeconds: number | null;
  /**
   * Full laps behind the leader (from distance, not pace, so a slow car
   * can't read extra laps down). Lapped cars read "+N LAP" instead of a
   * seconds gap - timing screens never show "+90.0" for a lapped car.
   */
  lapsDown: number;
  isPlayer: boolean;
}

/**
 * Orders tower entries the F1 broadcast way: by finishing position, the
 * leader first. Pure over data (no DOM) so the tower is unit-testable;
 * the race loop renders the returned order into tower HTML.
 */
export function orderTowerEntries(entries: readonly TowerEntry[]): TowerEntry[] {
  return [...entries].sort((a, b) => a.position - b.position);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders an F1-style timing tower (position, code chip, gap) as HTML - one
 * row per entry, in the order orderTowerEntries returns. Gap seconds come
 * from each follower's own speed (distance gap / follower speed, floored at
 * a crawl so a stationary car reads a large but finite gap): an
 * approximation of timing-loop gaps, documented as such, and only ever
 * displayed - positions always come from distance. Codes are escaped;
 * colors are validated hex from the roster before they get here.
 */
export function renderTowerHtml(entries: readonly TowerEntry[]): string {
  return orderTowerEntries(entries)
    .map((entry) => {
      let gap: string;
      if (entry.gapSeconds === null) {
        gap = "LEADER";
      } else if (entry.lapsDown >= 1) {
        gap = entry.lapsDown === 1 ? "+1 LAP" : `+${entry.lapsDown} LAPS`;
      } else {
        gap = `+${entry.gapSeconds.toFixed(1)}`;
      }
      return (
        `<div class="tower-row${entry.isPlayer ? " tower-row-you" : ""}">` +
        `<span class="tower-pos">P${entry.position}</span>` +
        `<span class="code-chip" style="background:${entry.color}">${escapeHtml(entry.code)}</span>` +
        `<span class="tower-gap">${gap}</span></div>`
      );
    })
    .join("");
}

/**
 * Builds tower entries (positions + gaps) for the player plus every
 * opponent from live progress. Gap meters convert with the follower's own
 * speed (see renderTowerHtml); a stopped follower floors at a crawl so
 * the tower never divides by zero or shows infinity.
 */
export function buildTowerEntries(
  player: { code: string; color: string; progress: RaceProgress },
  opponents: readonly { code: string; color: string; progress: RaceProgress }[],
  trackLengthMeters: number
): TowerEntry[] {
  const progresses = [player.progress, ...opponents.map((o) => o.progress)];
  const positions = computeRacePositions(progresses, trackLengthMeters);
  const leaderTotal = Math.max(...progresses.map((p) => totalDistance(p, trackLengthMeters)));
  const toEntry = (
    code: string,
    color: string,
    progress: RaceProgress,
    position: number,
    isPlayer: boolean
  ): TowerEntry => {
    if (position === 1) {
      return { code, color, position, gapSeconds: null, lapsDown: 0, isPlayer };
    }
    const gapMeters = leaderTotal - totalDistance(progress, trackLengthMeters);
    const speedMs = Math.max(progress.speedMs ?? 0, 5);
    return {
      code,
      color,
      position,
      gapSeconds: gapMeters / speedMs,
      lapsDown: Math.floor(gapMeters / trackLengthMeters),
      isPlayer,
    };
  };
  return [
    toEntry(player.code, player.color, player.progress, positions[0], true),
    ...opponents.map((o, k) => toEntry(o.code, o.color, o.progress, positions[k + 1], false)),
  ];
}
