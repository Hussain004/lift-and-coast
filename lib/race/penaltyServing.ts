// Drive-through and stop-go penalties, served through the pit lane. The
// steward still charges the time up front (see raceControl.ts); serving the
// penalty refunds it, so an unserved one simply stays on the result as the
// time cost - the real "add it to the race time" fallback.

export type ServedKind = "drive-through" | "stop-go";

export interface PendingPenalty {
  kind: ServedKind;
  /** Time already charged, refunded when served. */
  seconds: number;
}

export interface ServeState {
  queue: PendingPenalty[];
  /** Was in the pit lane last tick, for the drive-through exit edge. */
  inLane: boolean;
  /** Seconds stationary in the box for the current stop-go. */
  stopSeconds: number;
}

export const STOP_GO_HOLD_SECONDS = 10;
const STOPPED_MS = 0.6;

export function createServeState(): ServeState {
  return { queue: [], inLane: false, stopSeconds: 0 };
}

export function queuePenalty(state: ServeState, kind: ServedKind, seconds: number): void {
  state.queue.push({ kind, seconds });
}

/** Advances serving; returns the penalty served this tick, if any. */
export function stepServe(
  state: ServeState,
  input: { inLane: boolean; inBox: boolean; speedMs: number; dt: number }
): PendingPenalty | null {
  const head = state.queue[0];
  const leftLane = state.inLane && !input.inLane;
  state.inLane = input.inLane;
  if (!head) return null;
  if (head.kind === "drive-through") {
    if (!leftLane) return null;
    return state.queue.shift() ?? null;
  }
  // Stop-go: the clock only runs while stopped in the box.
  if (input.inBox && Math.abs(input.speedMs) < STOPPED_MS) state.stopSeconds += input.dt;
  else if (!input.inBox) state.stopSeconds = 0;
  if (state.stopSeconds < STOP_GO_HOLD_SECONDS) return null;
  state.stopSeconds = 0;
  return state.queue.shift() ?? null;
}

/** The chip text while a penalty is waiting to be served, else "". */
export function servePrompt(state: ServeState, input: { inLane: boolean; inBox: boolean }): string {
  const head = state.queue[0];
  if (!head) return "";
  if (head.kind === "drive-through") {
    return input.inLane ? "DRIVE-THROUGH · STAY IN THE LANE TO THE EXIT" : "DRIVE-THROUGH · ENTER THE PIT LANE";
  }
  if (input.inBox && state.stopSeconds > 0) {
    return `STOP-GO · HOLD ${Math.max(0, STOP_GO_HOLD_SECONDS - state.stopSeconds).toFixed(1)} S`;
  }
  return input.inLane ? "STOP-GO · STOP IN THE BOX" : "STOP-GO · ENTER THE PIT LANE";
}
