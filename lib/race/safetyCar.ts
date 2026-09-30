// Safety car and virtual safety car. Pure state machine plus a seeded plan;
// the cap it produces is an absolute speed ceiling (see computeAIControls'
// speedCapMs). The AI keeps its validated corner speeds and only loses its
// straight-line speed, which is why this is stable where scaling the whole
// speed profile down is not (measured: it jams the car in Monaco's hairpin).

export type SafetyCarSetting = "off" | "rare" | "frequent";
export const DEFAULT_SAFETY_CAR_SETTING: SafetyCarSetting = "rare";

export function isSafetyCarSetting(value: unknown): value is SafetyCarSetting {
  return value === "off" || value === "rare" || value === "frequent";
}

export type SafetyCarKind = "vsc" | "sc";
export type SafetyPhase = "none" | "active" | "ending";

/** Speed ceilings, m/s: 137 km/h behind the safety car, 198 km/h under a VSC. */
export const SC_CAP_MS = 38;
export const VSC_CAP_MS = 55;
/** Seconds of "VSC ending" warning before the green flag. */
const VSC_ENDING_SECONDS = 4;
/** An AI car parked this long on the racing surface calls out a VSC. */
export const STOPPED_CAR_SECONDS = 8;
/** No period is planned or called after this many laps before the flag. */
const FINISH_MARGIN_LAPS = 1.5;
const MIN_RACE_LAPS = 3;

export interface SafetyCarPeriod {
  kind: SafetyCarKind;
  /** Leader's distance, in laps, when it is called. */
  startLaps: number;
  durationLaps: number;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DURATION_LAPS: Record<SafetyCarKind, number> = { sc: 1, vsc: 0.8 };

/** The scripted periods for a race: deterministic for a (setting, laps, seed). */
export function planSafetyCar(setting: SafetyCarSetting, raceLaps: number, seed: number): SafetyCarPeriod[] {
  if (setting === "off" || raceLaps < MIN_RACE_LAPS) return [];
  const rng = mulberry32(seed ^ 0x5afe7ca4);
  const chances = setting === "frequent" ? [0.85, 0.35] : [0.4, 0];
  const periods: SafetyCarPeriod[] = [];
  let earliest = 0.7;
  for (const chance of chances) {
    if (rng() >= chance) continue;
    const kind: SafetyCarKind = rng() < 0.4 ? "sc" : "vsc";
    const latest = raceLaps - FINISH_MARGIN_LAPS - DURATION_LAPS[kind] - 0.2;
    if (latest <= earliest) break;
    const startLaps = earliest + rng() * (latest - earliest);
    periods.push({ kind, startLaps, durationLaps: DURATION_LAPS[kind] });
    earliest = startLaps + DURATION_LAPS[kind] + 1.5;
  }
  return periods;
}

export interface SafetyCarState {
  phase: SafetyPhase;
  kind: SafetyCarKind;
  plan: SafetyCarPeriod[];
  nextPlanned: number;
  /** Leader distance (laps) when the active period ends its racing phase. */
  endsAtLaps: number;
  /** Leader lap count that ends a safety-car "in this lap" phase. */
  greenAtLaps: number;
  endingSeconds: number;
  /** Reactive calls are held off until the leader has run this far. */
  cooldownUntilLaps: number;
  /** Bumps on every deploy/ending/green so the UI can react once. */
  serial: number;
}

export function createSafetyCarState(plan: SafetyCarPeriod[]): SafetyCarState {
  return {
    phase: "none",
    kind: "vsc",
    plan,
    nextPlanned: 0,
    endsAtLaps: 0,
    greenAtLaps: 0,
    endingSeconds: 0,
    cooldownUntilLaps: 0.5,
    serial: 0,
  };
}

export type SafetyCarEvent = { type: "deploy" | "ending" | "green"; kind: SafetyCarKind };

export interface SafetyCarInput {
  dt: number;
  /** The race leader's distance in laps (fractional). */
  leaderLaps: number;
  raceLaps: number;
  /** Lights out and no chequered flag yet. */
  racing: boolean;
  /** Longest time any AI car has sat stopped on the racing surface, seconds. */
  stoppedCarSeconds: number;
  /** Reactive calls (a stopped car) allowed by the setting. */
  reactive: boolean;
}

function deploy(state: SafetyCarState, kind: SafetyCarKind, leaderLaps: number, durationLaps: number): SafetyCarEvent {
  state.phase = "active";
  state.kind = kind;
  state.endsAtLaps = leaderLaps + durationLaps;
  state.serial++;
  return { type: "deploy", kind };
}

/** Advances the state machine; returns the event that happened this call, if any. */
export function stepSafetyCar(state: SafetyCarState, input: SafetyCarInput): SafetyCarEvent | null {
  const { leaderLaps, raceLaps } = input;
  if (!input.racing) {
    if (state.phase !== "none") {
      state.phase = "none";
      state.serial++;
      return { type: "green", kind: state.kind };
    }
    return null;
  }
  if (state.phase === "none") {
    const planned = state.plan[state.nextPlanned];
    if (planned && leaderLaps >= planned.startLaps) {
      state.nextPlanned++;
      return deploy(state, planned.kind, leaderLaps, planned.durationLaps);
    }
    if (
      input.reactive &&
      input.stoppedCarSeconds >= STOPPED_CAR_SECONDS &&
      leaderLaps >= state.cooldownUntilLaps &&
      leaderLaps <= raceLaps - FINISH_MARGIN_LAPS - DURATION_LAPS.vsc
    ) {
      return deploy(state, "vsc", leaderLaps, DURATION_LAPS.vsc);
    }
    return null;
  }
  // Never hold the field through the last stretch.
  if (leaderLaps >= raceLaps - 0.5) {
    state.phase = "none";
    state.cooldownUntilLaps = Infinity;
    state.serial++;
    return { type: "green", kind: state.kind };
  }
  if (state.phase === "active" && leaderLaps >= state.endsAtLaps) {
    state.phase = "ending";
    state.endingSeconds = 0;
    // A safety car comes in at the end of the lap; a VSC ends on a timer.
    state.greenAtLaps = Math.floor(leaderLaps) + 1;
    state.serial++;
    return { type: "ending", kind: state.kind };
  }
  if (state.phase === "ending") {
    state.endingSeconds += input.dt;
    const done = state.kind === "sc" ? leaderLaps >= state.greenAtLaps : state.endingSeconds >= VSC_ENDING_SECONDS;
    if (done) {
      state.phase = "none";
      state.cooldownUntilLaps = leaderLaps + 1.5;
      state.serial++;
      return { type: "green", kind: state.kind };
    }
  }
  return null;
}

/** The ceiling in force, m/s, or null when racing. */
export function safetyCarCapMs(state: SafetyCarState): number | null {
  if (state.phase === "none") return null;
  return state.kind === "sc" ? SC_CAP_MS : VSC_CAP_MS;
}

/**
 * Cars behind the leader are let run a little over the ceiling to close the
 * gap to the car ahead (the field bunches up behind the safety car).
 */
export function catchUpBonusMs(gapAheadMeters: number | null): number {
  if (gapAheadMeters === null || !Number.isFinite(gapAheadMeters)) return 0;
  return Math.min(12, Math.max(0, (gapAheadMeters - 18) * 0.25));
}

const kmh = (ms: number) => Math.round(ms * 3.6);

/** HUD chip text, "" when racing. */
export function safetyCarText(state: SafetyCarState): string {
  if (state.phase === "none") return "";
  const name = state.kind === "sc" ? "SAFETY CAR" : "VIRTUAL SAFETY CAR";
  if (state.phase === "ending") return state.kind === "sc" ? "SAFETY CAR IN THIS LAP" : "VSC ENDING";
  const cap = state.kind === "sc" ? SC_CAP_MS : VSC_CAP_MS;
  return `${name} · MAX ${kmh(cap)} KM/H · NO OVERTAKING`;
}

/** The engineer's calls, keyed by event. */
export function safetyCarRadio(event: SafetyCarEvent): string {
  if (event.type === "deploy") {
    return event.kind === "sc"
      ? "Safety car, safety car. Stay in position, keep it under 137."
      : "Virtual safety car. Stay under the delta, no overtaking.";
  }
  if (event.type === "ending") {
    return event.kind === "sc" ? "Safety car is in this lap. Get ready to go." : "VSC ending. Be ready to go.";
  }
  return "Green, green. We're racing again.";
}

/**
 * Metres from car `index` to the nearest car ahead of it on the road (by
 * total distance raced), or null for the leader. Used to size the catch-up
 * allowance behind the safety car.
 */
export function gapAheadMeters(
  progresses: readonly { lapCount: number; progressMeters: number }[],
  index: number,
  trackLengthMeters: number
): number | null {
  const own = progresses[index];
  if (!own) return null;
  const total = (p: { lapCount: number; progressMeters: number }) => p.lapCount * trackLengthMeters + p.progressMeters;
  const mine = total(own);
  let best: number | null = null;
  progresses.forEach((p, i) => {
    if (i === index) return;
    const gap = total(p) - mine;
    if (gap > 0 && (best === null || gap < best)) best = gap;
  });
  return best;
}
