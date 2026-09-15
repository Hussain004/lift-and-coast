export interface RaceProgress {
  lapCount: number;
  /** Arc-length distance from the start/finish line, meters - resets to ~0 each lap. */
  progressMeters: number;
}

/** Shared, mutable (not React state - written every physics tick by both cars). */
export interface RaceState {
  player: RaceProgress;
  ai: RaceProgress;
}

export function createRaceState(): RaceState {
  return { player: { lapCount: 0, progressMeters: 0 }, ai: { lapCount: 0, progressMeters: 0 } };
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
  const playerTotal = player.lapCount * trackLengthMeters + player.progressMeters;
  const aiTotal = ai.lapCount * trackLengthMeters + ai.progressMeters;
  return playerTotal >= aiTotal ? 1 : 2;
}
