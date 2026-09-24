import type { TrackData } from "../tracks/types";

/** 2026-style overtake mode is available only in designated regions. */
export type OvertakeMode = "race" | "practice" | "qualifying";

export interface OvertakeZone {
  id: number;
  startMeters: number;
  endMeters: number;
  lengthMeters: number;
}

export interface OvertakeState {
  mode: OvertakeMode;
  zoneId: number | null;
  speedEligible: boolean;
  proximityEligible: boolean;
  available: boolean;
  active: boolean;
  requested: boolean;
  lastActive: boolean;
}

export const OVERTAKE_MIN_SPEED_MS = 25;
export const OVERTAKE_WINDOW_SECONDS = 1;
export const OVERTAKE_BOOST_MULTIPLIER = 1.12;

function wrapDistance(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function inZone(progressMeters: number, zone: OvertakeZone, lapLengthMeters: number): boolean {
  const p = wrapDistance(progressMeters, lapLengthMeters);
  if (zone.startMeters <= zone.endMeters) return p >= zone.startMeters && p <= zone.endMeters;
  return p >= zone.startMeters || p <= zone.endMeters;
}

/**
 * Finds long low-curvature sections from the actual centerline. This is a
 * deterministic track-derived list, so every circuit gets the same overtake
 * regions without maintaining a second hand-authored map.
 */
export function buildOvertakeZones(track: TrackData): OvertakeZone[] {
  const n = track.centerline.length;
  if (n < 8) return [];
  const pointAt = (i: number) => track.centerline[((i % n) + n) % n];
  const straight = new Array<boolean>(n).fill(false);
  const window = 5;
  for (let i = 0; i < n; i++) {
    const before = pointAt(i - window);
    const after = pointAt(i + window);
    const beforePrev = pointAt(i - window - 1);
    const afterNext = pointAt(i + window + 1);
    const inX = before[0] - beforePrev[0];
    const inZ = before[2] - beforePrev[2];
    const outX = afterNext[0] - after[0];
    const outZ = afterNext[2] - after[2];
    const inLength = Math.hypot(inX, inZ) || 1;
    const outLength = Math.hypot(outX, outZ) || 1;
    const turn = Math.abs(
      Math.atan2(
        (inX * outZ - inZ * outX) / (inLength * outLength),
        (inX * outX + inZ * outZ) / (inLength * outLength)
      )
    );
    straight[i] = turn < 0.12 && Math.hypot(after[0] - before[0], after[2] - before[2]) > 1;
  }

  const runs: Array<{ start: number; end: number; length: number }> = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    const isStraight = i < n && straight[i];
    if (isStraight && start < 0) start = i;
    if (!isStraight && start >= 0) {
      const length = i - start;
      if (length >= 8) runs.push({ start, end: i, length });
      start = -1;
    }
  }
  if (start >= 0) {
    const first = runs[0];
    if (first && first.start === 0) {
      first.start = start - n;
      first.length += n - start;
    } else {
      runs.push({ start: start - n, end: n, length: n - start });
    }
  }
  const chosen = runs
    .sort((a, b) => b.length - a.length)
    .slice(0, 3)
    .sort((a, b) => a.start - b.start);
  return chosen.map((run, index) => {
    const startMeters = wrapDistance((run.start / n) * track.lengthMeters, track.lengthMeters);
    const endMeters = wrapDistance((run.end / n) * track.lengthMeters, track.lengthMeters);
    return {
      id: index + 1,
      startMeters,
      endMeters,
      lengthMeters: (run.length / n) * track.lengthMeters,
    };
  });
}

export function createOvertakeSystem(track: TrackData, mode: OvertakeMode = "race") {
  const zones = buildOvertakeZones(track);
  const state: OvertakeState = {
    mode,
    zoneId: null,
    speedEligible: false,
    proximityEligible: false,
    available: false,
    active: false,
    requested: false,
    lastActive: false,
  };

  function setRequested(requested: boolean) {
    state.requested = requested;
  }

  function update(progressMeters: number, speedMs: number, gapAheadMeters?: number): OvertakeState {
    const zone = zones.find((candidate) => inZone(progressMeters, candidate, track.lengthMeters)) ?? null;
    const speed = Math.abs(speedMs);
    const proximityEligible =
      state.mode === "race"
        ? gapAheadMeters === undefined || (gapAheadMeters > 0 && gapAheadMeters <= speed * OVERTAKE_WINDOW_SECONDS)
        : true;
    state.zoneId = zone?.id ?? null;
    state.speedEligible = zone !== null && speed >= OVERTAKE_MIN_SPEED_MS;
    state.proximityEligible = proximityEligible;
    state.available = state.speedEligible && proximityEligible;
    state.lastActive = state.active;
    state.active = state.requested && state.available;
    return { ...state };
  }

  function snapshot(): OvertakeState {
    return { ...state };
  }

  return { zones, state, setRequested, update, snapshot };
}

export function overtakeSummary(state: OvertakeState): string {
  if (state.active) return "OVERTAKE ACTIVE";
  if (state.available) return state.requested ? "OVERTAKE ARMED" : "OVERTAKE AVAILABLE";
  if (state.zoneId === null) return "OVERTAKE CLOSED";
  return state.speedEligible ? "OVERTAKE WAIT" : "OVERTAKE TOO SLOW";
}
