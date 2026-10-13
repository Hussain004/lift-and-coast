// A race's lap-by-lap record, for the post-race debrief. The race loop only
// reports "car i has completed N laps" each frame; this notes the race-clock
// time every car crossed the line each lap, and everything else (lap times,
// the lap chart, who led when) is derived from that. Pure; one small array
// per car, no per-frame allocation once a lap has been recorded.

export interface RaceLog {
  /** completedAt[car][lap - 1] = race-clock seconds the car finished that lap. */
  completedAt: number[][];
  /** The player's (car 0) tyre compound for each lap they completed. */
  playerCompounds: string[];
  /** Race-clock seconds when the lights went out; lap 1 is measured from here. */
  startClock: number | null;
}

export function createRaceLog(cars: number): RaceLog {
  return { completedAt: Array.from({ length: cars }, () => []), playerCompounds: [], startClock: null };
}

/**
 * Notes any newly completed laps. `laps[i]` is car i's completed-lap count;
 * `maxLaps` stops a car still running after the flag from logging extra laps.
 * Counts only ever grow here, so a rewind that re-crosses the line is ignored.
 */
export function recordLaps(
  log: RaceLog,
  laps: readonly number[],
  clockSeconds: number,
  maxLaps: number,
  playerCompound: string
): void {
  for (let i = 0; i < log.completedAt.length; i++) {
    const done = log.completedAt[i];
    const target = Math.min(laps[i] ?? 0, maxLaps);
    while (done.length < target) {
      done.push(clockSeconds);
      if (i === 0) log.playerCompounds.push(playerCompound);
    }
  }
}

/** Each car's lap times in seconds (lap 1 is measured from the lights going out). */
export function lapTimesOf(log: RaceLog, car: number): number[] {
  const done = log.completedAt[car] ?? [];
  return done.map((t, i) => t - (i === 0 ? (log.startClock ?? 0) : done[i - 1]));
}

/**
 * Running order after `lap` laps: car indices, first to cross the line first.
 * Cars that have not completed the lap yet are left out.
 */
export function orderAfterLap(log: RaceLog, lap: number): number[] {
  const crossed: { car: number; at: number }[] = [];
  log.completedAt.forEach((done, car) => {
    if (done.length >= lap) crossed.push({ car, at: done[lap - 1] });
  });
  crossed.sort((a, b) => a.at - b.at || a.car - b.car);
  return crossed.map((c) => c.car);
}

export interface Debrief {
  /** One entry per car, in grid-slot order (index 0 is the player). */
  cars: { code: string; color: string; isPlayer: boolean }[];
  /** positions[lap - 1][car] = running position after that lap, or 0 if not yet crossed. */
  positions: number[][];
  /** lapTimes[car] = that car's lap times in seconds. */
  lapTimes: number[][];
  /** Tyre compound for each of the player's laps. */
  compounds: string[];
  /** The car with the fastest single lap, and that lap number (1-based). */
  fastest: { car: number; lap: number; seconds: number } | null;
}

export function buildDebrief(
  log: RaceLog,
  cars: Debrief["cars"],
  raceLaps: number
): Debrief {
  const positions: number[][] = [];
  for (let lap = 1; lap <= raceLaps; lap++) {
    const row = new Array<number>(cars.length).fill(0);
    orderAfterLap(log, lap).forEach((car, k) => {
      row[car] = k + 1;
    });
    positions.push(row);
  }
  const lapTimes = cars.map((_, car) => lapTimesOf(log, car));
  let fastest: Debrief["fastest"] = null;
  lapTimes.forEach((times, car) => {
    times.forEach((seconds, i) => {
      if (seconds > 0 && (fastest === null || seconds < fastest.seconds)) fastest = { car, lap: i + 1, seconds };
    });
  });
  return { cars, positions, lapTimes, compounds: log.playerCompounds.slice(), fastest };
}
