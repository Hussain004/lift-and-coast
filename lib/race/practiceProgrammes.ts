// Practice programmes for a championship weekend: three short objectives to
// chase in practice, each worth reputation (see objectives.ts). Pure and
// player-side only - nothing here reads or changes the AI.
import type { RacingLinePoint } from "../tracks/racingLine";

export type ProgrammeId = "acclimatisation" | "consistency" | "pace";

export const PROGRAMME_IDS: readonly ProgrammeId[] = ["acclimatisation", "consistency", "pace"];

export const PROGRAMME_LABELS: Record<ProgrammeId, string> = {
  acclimatisation: "Track acclimatisation",
  consistency: "Consistency",
  pace: "Qualifying pace",
};

export const GATE_COUNT = 10;
export const GATE_RADIUS_METERS = 5;
/** Two clean laps this close together (fraction of the faster) are "consistent". */
export const CONSISTENCY_TOLERANCE = 0.015;
/** The qualifying-pace target is the reference time of this grid slot (1-based). */
export const PACE_TARGET_GRID_SLOT = 15;

export interface Gate {
  x: number;
  /** Road height, for drawing the marker. */
  y: number;
  z: number;
}

/** Gates spread evenly around the racing line, the first a little way past the start. */
export function buildGates(line: readonly RacingLinePoint[], count = GATE_COUNT): Gate[] {
  if (line.length === 0) return [];
  return Array.from({ length: count }, (_, i) => {
    const point = line[Math.floor(((i + 0.5) / count) * line.length) % line.length].position;
    return { x: point[0], y: point[1], z: point[2] };
  });
}

/** The reference lap of grid slot `slot` (1-based) among the rivals' times, if the field is that big. */
export function paceTarget(rivalTimes: readonly number[], slot = PACE_TARGET_GRID_SLOT): number | null {
  const sorted = rivalTimes.filter((t) => Number.isFinite(t) && t > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length, slot) - 1];
}

export interface ProgrammeState {
  gateHits: boolean[];
  /** The last valid lap of an unbroken run of valid laps, else null. */
  lastCleanLap: number | null;
  paceTargetSeconds: number | null;
  done: Record<ProgrammeId, boolean>;
}

export function createProgrammeState(
  gateCount: number,
  paceTargetSeconds: number | null,
  alreadyDone: Partial<Record<ProgrammeId, boolean>> = {}
): ProgrammeState {
  return {
    gateHits: Array.from({ length: gateCount }, () => false),
    lastCleanLap: null,
    paceTargetSeconds,
    done: {
      acclimatisation: !!alreadyDone.acclimatisation,
      consistency: !!alreadyDone.consistency,
      pace: !!alreadyDone.pace,
    },
  };
}

/** Marks gates the car is on; returns the programme completed by this step, if any. */
export function stepGates(state: ProgrammeState, gates: readonly Gate[], x: number, z: number): ProgrammeId | null {
  for (let i = 0; i < gates.length; i++) {
    if (!state.gateHits[i] && Math.hypot(gates[i].x - x, gates[i].z - z) <= GATE_RADIUS_METERS) state.gateHits[i] = true;
  }
  if (!state.done.acclimatisation && gates.length > 0 && state.gateHits.every(Boolean)) {
    state.done.acclimatisation = true;
    return "acclimatisation";
  }
  return null;
}

/** Feeds a finished lap; returns the programmes it completed. */
export function recordProgrammeLap(state: ProgrammeState, seconds: number, valid: boolean): ProgrammeId[] {
  const completed: ProgrammeId[] = [];
  if (!valid || !(seconds > 0)) {
    state.lastCleanLap = null;
    return completed;
  }
  if (!state.done.consistency && state.lastCleanLap !== null) {
    const fast = Math.min(seconds, state.lastCleanLap);
    if (Math.abs(seconds - state.lastCleanLap) / fast <= CONSISTENCY_TOLERANCE) {
      state.done.consistency = true;
      completed.push("consistency");
    }
  }
  state.lastCleanLap = seconds;
  if (!state.done.pace && state.paceTargetSeconds !== null && seconds <= state.paceTargetSeconds) {
    state.done.pace = true;
    completed.push("pace");
  }
  return completed;
}

/** One-line HUD readout. */
export function programmeSummary(state: ProgrammeState): string {
  const gates = state.gateHits.filter(Boolean).length;
  const mark = (done: boolean, text: string) => (done ? `✓ ${text}` : text);
  return [
    mark(state.done.acclimatisation, `GATES ${gates}/${state.gateHits.length}`),
    mark(state.done.consistency, "2 LAPS WITHIN 1.5%"),
    ...(state.paceTargetSeconds !== null ? [mark(state.done.pace, `LAP UNDER ${formatTarget(state.paceTargetSeconds)}`)] : []),
  ].join("  ·  ");
}

function formatTarget(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, "0")}`;
}
