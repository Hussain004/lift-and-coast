// Pre-race tyre strategy advice, from the same tyre model the car runs on:
// how fast each compound loses grip per metre, and the pace that costs.
// Informational only (the player's pit call is still their own), and the
// numbers are ESTIMATES: the lap-time cost of grip loss and the pit loss are
// chosen constants, not measurements.

import { TIRE_COMPOUNDS, computeCompoundGripMultiplier, type TireCompoundId } from "../physics/tireModel";

type Slick = "soft" | "medium" | "hard";
const SLICKS: Slick[] = ["soft", "medium", "hard"];

/** Seconds lost to a stop beyond standing still: the pit-lane limiter and entry/exit. */
export const PIT_LANE_LOSS_SECONDS = 18;
export const PIT_SERVICE_ESTIMATE_SECONDS = 3.2;
/** Lap time lengthens by this fraction per unit of grip lost (an estimate). */
const LAP_TIME_PER_GRIP_LOST = 0.5;
/** A fresh soft is a touch quicker than a hard even before wear (an estimate). */
const FRESH_PACE_BONUS: Record<Slick, number> = { soft: 0.006, medium: 0.003, hard: 0 };
/** Strategy advice is for races where a stop can pay: the same bar the AI uses to pit. */
export const MIN_ADVICE_LAPS = 5;

/** Extra fraction of a base lap spent on a lap run `lapIndex` laps into a stint on `compound`. */
function lapCost(compound: Slick, lapIndex: number, lapMeters: number): number {
  const gripMid = computeCompoundGripMultiplier(TIRE_COMPOUNDS[compound], (lapIndex + 0.5) * lapMeters);
  return (1 - gripMid) * LAP_TIME_PER_GRIP_LOST - FRESH_PACE_BONUS[compound];
}

function stintCost(compound: Slick, laps: number, lapMeters: number): number {
  let sum = 0;
  for (let i = 0; i < laps; i++) sum += lapCost(compound, i, lapMeters);
  return sum;
}

export interface StrategyOption {
  /** Compounds in the order they are run. */
  compounds: Slick[];
  /** Lap after which to pit (1-based), or null for no stop. */
  pitLap: number | null;
  /** Estimated extra seconds over a perfect, fresh-tyre race, given the track's base lap. */
  extraSeconds: number;
}

/**
 * Every no-stop and one-stop plan over the slicks, best first. `baseLapSeconds`
 * scales the pace cost; pass the circuit's rough lap time.
 */
export function strategyOptions(lapMeters: number, laps: number, baseLapSeconds: number): StrategyOption[] {
  if (laps < 1 || lapMeters <= 0) return [];
  const options: StrategyOption[] = [];
  for (const a of SLICKS) {
    options.push({ compounds: [a], pitLap: null, extraSeconds: stintCost(a, laps, lapMeters) * baseLapSeconds });
  }
  if (laps >= 2) {
    for (const a of SLICKS) {
      for (const b of SLICKS) {
        let best: StrategyOption | null = null;
        for (let pit = 1; pit < laps; pit++) {
          const extra =
            (stintCost(a, pit, lapMeters) + stintCost(b, laps - pit, lapMeters)) * baseLapSeconds +
            PIT_LANE_LOSS_SECONDS +
            PIT_SERVICE_ESTIMATE_SECONDS;
          if (best === null || extra < best.extraSeconds) best = { compounds: [a, b], pitLap: pit, extraSeconds: extra };
        }
        if (best) options.push(best);
      }
    }
  }
  return options.sort((x, y) => x.extraSeconds - y.extraSeconds);
}

const NAMES: Record<TireCompoundId, string> = {
  soft: "Soft",
  medium: "Medium",
  hard: "Hard",
  intermediate: "Inter",
  wet: "Wet",
};

/** "Medium → Hard, pit after lap 3" / "Hard, no stop". */
export function describeStrategy(option: StrategyOption): string {
  const tyres = option.compounds.map((c) => NAMES[c]).join(" → ");
  return option.pitLap === null ? `${tyres}, no stop` : `${tyres}, pit after lap ${option.pitLap}`;
}

/** The top options, each with its gap to the best (the first is 0). */
export function adviceFor(lapMeters: number, laps: number, baseLapSeconds: number, count = 3) {
  const all = strategyOptions(lapMeters, laps, baseLapSeconds).slice(0, count);
  return all.map((option) => ({
    option,
    text: describeStrategy(option),
    gapSeconds: option.extraSeconds - all[0].extraSeconds,
  }));
}
