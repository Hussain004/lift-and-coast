// The race HUD's data layer. Car.tsx writes plain values into one mutable
// HudSnapshot every frame; the widgets in app/race/hud/ read it on their own
// animation frames and write their own DOM. Nothing here is React state and
// nothing here touches the DOM, so the physics loop never formats a string
// and the HUD can be redesigned without editing the simulation.
import type { EnergyMode } from "../physics/energy";
import type { TireCompoundId } from "../physics/tireModel";
import { TIRE_COMPOUNDS } from "../physics/tireModel";
import type { WeatherPreset } from "../physics/weather";
import type { PitPhase, StrategyMode } from "./strategy";
import type { PitReleasePhase } from "./pitRelease";
import type { createFlashbackTrace } from "./flashbackTimeline";

/** The trace handle carried by reference on the snapshot (see below). */
export type FlashbackTrace = ReturnType<typeof createFlashbackTrace>;
import type { SectorColor } from "./sectorTimer";
import type { TowerEntry } from "./racePosition";
import type { SessionMode } from "./sessionSetup";

export type HudEventKind = "info" | "good" | "purple" | "warn" | "penalty" | "flag" | "radio";

export interface HudEvent {
  id: number;
  kind: HudEventKind;
  title: string;
  detail?: string;
  /** How long the banner stays up, in seconds. */
  seconds: number;
}

export interface HudSector {
  seconds: number;
  color: SectorColor;
}

/** One row of a finished race's classification. */
export interface ClassifiedRow {
  position: number;
  code: string;
  name: string | null;
  teamId: string | null;
  color: string;
  isPlayer: boolean;
  /** Race time including penalties; null for a car still running at the flag. */
  totalSeconds: number | null;
  /** Laps completed at classification. */
  laps: number;
  bestLapSeconds: number | null;
  penaltySeconds: number;
  points: number;
  fastestLap: boolean;
}

export interface QualifyingRow {
  position: number;
  code: string;
  name: string | null;
  color: string;
  isPlayer: boolean;
  time: number | null;
  /** Relative to the player's best when they have one, else to pole. */
  gap: number | null;
}

export type SessionResult =
  | {
      kind: "race";
      position: number;
      laps: number;
      rows: ClassifiedRow[];
      penaltySeconds: number;
      disqualified: boolean;
      champRound: number | null;
      points: number;
      /** A championship sprint rather than the grand prix. */
      sprint?: boolean;
    }
  | { kind: "practice"; laps: number; bestLapSeconds: number | null }
  | {
      kind: "qualifying";
      position: number;
      playerTime: number | null;
      rows: QualifyingRow[];
      raceHref: string;
      champRound: number | null;
    };

export interface HudSnapshot {
  // Car
  speedKmh: number;
  gear: string;
  /** 0-1 across idle..redline. */
  rpm01: number;
  /** Shift-light state: below the band, in the optimal band, or at the shift point. */
  rpmZone: "low" | "band" | "shift";
  throttle: number;
  brake: number;
  steer: number;
  ers01: number;
  ersMode: EnergyMode;
  deployBudget01: number;
  lowDrag: boolean;
  overtakeActive: boolean;
  compound: TireCompoundId;
  /** Live tyre grip fraction (wear x temperature x weather). */
  tyreGrip: number;
  tyreTempC: number;
  /** Estimated per-corner temperatures, FL FR RL RR (see wheelTemps.ts). */
  wheelTempC: [number, number, number, number];
  /** 0 fresh .. 1 at the end of the compound's intended life. */
  tyreWear01: number;
  fuelKg: number;
  fuelWarning: boolean;
  strategyMode: StrategyMode;
  pitPhase: PitPhase;
  pitStops: number;
  /** On the drivable pit lane: the limiter is on. */
  inPitLane: boolean;
  /** This circuit has a drivable pit lane (else the old virtual window applies). */
  hasPitLane: boolean;
  pitProgress: number;
  /** Metres to your box along the lane (negative once passed); null off the lane or on circuits without one. */
  pitBoxMeters: number | null;
  /** Chip text while a drive-through/stop-go waits to be served, else "". */
  servePrompt: string;
  /**
   * The release mini-game's state (see lib/race/pitRelease.ts) and the chip
   * text for it, "" whenever there is nothing to say. Written every frame by
   * Car.tsx alongside pitProgress, so the HUD widget only ever reads plain
   * values - the machine itself never touches the snapshot.
   */
  pitReleasePhase: PitReleasePhase;
  pitReleaseText: string;
  /** Practice-programme progress line (championship practice only), else "". */
  programmeText: string;
  /** Safety car / VSC banner text (see lib/race/safetyCar.ts), "" when racing. */
  safetyCarText: string;
  /** Practice gates on the racing line; hits mutate in place as they are driven through. */
  gates: { x: number; y: number; z: number }[];
  gateHits: boolean[];
  /** 1 = undamaged. */
  damage: number;
  /** Health of each part, 1 = intact (see lib/physics/damage.ts); puncture = wheel index or -1. */
  damageParts: { frontWing: number; rearWing: number; floor: number; puncture: number };
  /** Extra pit-stop seconds the current damage would cost. */
  damageRepairSeconds: number;
  /** While a flashback is being scrubbed: seconds rewound so far and how far back it can go (0 when idle). */
  flashbackSeconds: number;
  flashbackCapacity: number;
  /**
   * The flashback timeline (lib/race/flashbackTimeline.ts) is open and the race
   * is paused for it. The strip widget reads this to decide whether to draw,
   * and `flashbackSeconds` / `flashbackCapacity` carry the scrub head while it
   * is set.
   */
  flashbackTimelineOpen: boolean;
  /**
   * The live flash trace, by REFERENCE and never copied (see
   * lib/race/flashbackTimeline.ts's writeFlashbackStrip). Gameplay code owns
   * it because it is fed from the physics step; the strip widget reads it on
   * its own HUD tick. Carrying the reference rather than the samples is what
   * keeps a 20Hz redraw allocation-free.
   */
  flashbackTrace?: FlashbackTrace;
  /** Flashbacks left this session; null = unlimited. */
  flashbacksLeft: number | null;
  tc: boolean;
  abs: boolean;
  autoGear: boolean;
  pad: boolean;
  racingLine: boolean;
  weather: WeatherPreset;
  /** Changeable weather: seconds to the next scripted change and what it brings. */
  forecastInSeconds: number | null;
  forecastTo: WeatherPreset | null;
  trackTempC: number;
  // Timing
  sessionMode: SessionMode;
  timeAttack: boolean;
  /** Current lap, 1-based. */
  lap: number;
  totalLaps: number;
  lapSeconds: number;
  bestLapSeconds: number | null;
  lastLapSeconds: number | null;
  lapInvalid: boolean;
  delta: number | null;
  sectors: (HudSector | null)[];
  /** Qualifying clock (seconds left) and phase label, null when untimed. */
  clockSeconds: number | null;
  phase: string | null;
  position: number;
  fieldSize: number;
  /** Rebuilt at ~10Hz; towerVersion ticks on every rebuild. */
  tower: TowerEntry[];
  towerVersion: number;
  // Map
  x: number;
  z: number;
  yaw: number;
  offTrack: boolean;
  /** Live track-limits state while all four wheels are off, "" otherwise. */
  trackLimitText: string;
  /**
   * Race control's view of overtaking under a flag, e.g.
   * "OVERTAKING UNDER FLAG: WARNING 1/2" (see
   * lib/race/overtakePenalties.ts). "" when there is nothing to say. Carried
   * on the snapshot rather than pushed straight at the radio so the engineer
   * stays a pure function of successive snapshots, like every other call.
   */
  overtakePenaltyText: string;
  /**
   * Lines gameplay code wants the engineer to say, drained by
   * app/race/hud/Engineer.tsx on its next pass. See queueEngineerLine.
   */
  engineerQueue: string[];
  /** Marshal flag in force for the player ("YELLOW ..." / "BLUE FLAG ..."), or "". */
  flagText: string;
  /** Distance along the lap of the stopped car the yellow is for, metres; -1 when there is none. */
  yellowStation: number;
  chequered: boolean;
  // Messages and the end of the session
  events: HudEvent[];
  result: SessionResult | null;
}

export function createHudSnapshot(sessionMode: SessionMode = "race", totalLaps = 1): HudSnapshot {
  return {
    speedKmh: 0,
    gear: "N",
    rpm01: 0,
    rpmZone: "low",
    throttle: 0,
    brake: 0,
    steer: 0,
    ers01: 1,
    ersMode: "balanced",
    deployBudget01: 1,
    lowDrag: false,
    overtakeActive: false,
    compound: "medium",
    tyreGrip: 1,
    tyreTempC: 24,
    wheelTempC: [24, 24, 24, 24],
    tyreWear01: 0,
    fuelKg: 0,
    fuelWarning: false,
    strategyMode: "balanced",
    pitPhase: "none",
    pitStops: 0,
    inPitLane: false,
    hasPitLane: false,
    pitProgress: 0,
    pitBoxMeters: null,
    servePrompt: "",
    pitReleasePhase: "idle",
    pitReleaseText: "",
    programmeText: "",
    safetyCarText: "",
    gates: [],
    gateHits: [],
    damage: 1,
    damageParts: { frontWing: 1, rearWing: 1, floor: 1, puncture: -1 },
    damageRepairSeconds: 0,
    flashbackSeconds: 0,
    flashbackCapacity: 0,
    flashbackTimelineOpen: false,
    flashbackTrace: undefined,
    flashbacksLeft: null,
    tc: true,
    abs: true,
    autoGear: true,
    pad: false,
    racingLine: true,
    weather: "clear",
    forecastInSeconds: null,
    forecastTo: null,
    trackTempC: 30,
    sessionMode,
    timeAttack: false,
    lap: 1,
    totalLaps,
    lapSeconds: 0,
    bestLapSeconds: null,
    lastLapSeconds: null,
    lapInvalid: false,
    delta: null,
    sectors: [null, null, null],
    clockSeconds: null,
    phase: null,
    position: 1,
    fieldSize: 1,
    tower: [],
    towerVersion: 0,
    x: 0,
    z: 0,
    yaw: 0,
    offTrack: false,
    trackLimitText: "",
    overtakePenaltyText: "",
    engineerQueue: [],
    flagText: "",
    yellowStation: -1,
    chequered: false,
    events: [],
    result: null,
  };
}

const MAX_QUEUED_EVENTS = 24;
let nextEventId = 1;

/** Queues a banner. Bounded, so a HUD that is not mounted cannot leak. */
export function pushHudEvent(
  hud: HudSnapshot,
  kind: HudEventKind,
  title: string,
  detail?: string,
  seconds = 2.6
): void {
  hud.events.push({ id: nextEventId++, kind, title, detail, seconds });
  if (hud.events.length > MAX_QUEUED_EVENTS) hud.events.splice(0, hud.events.length - MAX_QUEUED_EVENTS);
}

/**
 * Queues a line for the race engineer to say on its next pass.
 *
 * The engineer is a pure function of successive HudSnapshots (see
 * lib/race/engineer.ts) and runs on its own 4Hz timer in
 * app/race/hud/Engineer.tsx, so gameplay code cannot hand it a line directly
 * without breaking that one-way flow. A queue on the snapshot is the same
 * pattern pushHudEvent already uses for banners: the producer writes, the
 * consumer drains. Bounded for the same reason MAX_QUEUED_EVENTS is - a
 * player who spins under a yellow must not be able to grow this without
 * limit, and the oldest line is the least relevant one.
 */
const MAX_QUEUED_ENGINEER_LINES = 4;

export function queueEngineerLine(hud: HudSnapshot, line: string): void {
  hud.engineerQueue.push(line);
  if (hud.engineerQueue.length > MAX_QUEUED_ENGINEER_LINES) {
    hud.engineerQueue.splice(0, hud.engineerQueue.length - MAX_QUEUED_ENGINEER_LINES);
  }
}

/** Drains the queued lines, oldest first. */
export function drainEngineerLines(hud: HudSnapshot): string[] {
  if (hud.engineerQueue.length === 0) return [];
  return hud.engineerQueue.splice(0, hud.engineerQueue.length);
}

/** Tyre wear as a 0..1 fraction of the compound's intended life. */
export function tyreWear01(compound: TireCompoundId, wornMeters: number): number {
  const loss = wornMeters * TIRE_COMPOUNDS[compound].degradationPerMeter;
  // The compound's grip floor is reached at 15% loss (see tireModel.ts).
  return Math.min(1, Math.max(0, loss / 0.15));
}

/** "+1.234" / "-0.456" / "" - fixed width friendly. */
export function formatGap(seconds: number | null, digits = 1): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  return `${seconds >= 0 ? "+" : "-"}${Math.abs(seconds).toFixed(digits)}`;
}

/** Race time: 1:23:45.678 over an hour, 23:45.678 under. */
export function formatRaceTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--.---";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${s.toFixed(3).padStart(6, "0")}`;
}

/** The tower's gap column: a time, "+N LAPS", or LEADER. */
export function towerGapLabel(seconds: number | null, lapsDown: number): string {
  if (seconds === null) return "LEADER";
  if (lapsDown >= 1) return lapsDown === 1 ? "+1 LAP" : `+${lapsDown} LAPS`;
  return `+${seconds.toFixed(1)}`;
}

/**
 * Which tower rows to show when collapsed: the leader, the two cars either
 * side of the player, and the player - like the broadcast's compact tower.
 * Returns row indices into a position-ordered list.
 */
export function compactTowerRows(count: number, playerIndex: number, rows = 5): number[] {
  if (count <= rows) return Array.from({ length: count }, (_, i) => i);
  const around = rows - 1; // one row is always the leader
  let start = Math.max(1, playerIndex - Math.floor(around / 2));
  start = Math.min(start, count - around);
  const out = [0];
  for (let i = start; i < start + around; i++) out.push(i);
  return out;
}

/** The pit prompt chip's text, or "" when there is nothing to say. */
export function pitPrompt(hud: HudSnapshot): string {
  // The release mini-game owns the chip while a stop is in progress: its
  // text already carries the service percentage, and it is the only part of
  // the stop the player can still act on, so it must not be crowded out by
  // the generic "PIT STOP · nn%" line.
  if (hud.pitReleaseText) return hud.pitReleaseText;
  if (hud.pitPhase === "service") return `PIT STOP · ${Math.round(hud.pitProgress * 100)}%`;
  if (hud.servePrompt) return hud.servePrompt;
  if (hud.inPitLane) {
    const box = hud.pitBoxMeters;
    if (hud.pitPhase === "requested" && box !== null) {
      if (box > 3) return `PIT LANE · BOX ${Math.round(box)} M · STOP IN THE GREEN`;
      if (box < -3) return "BOX MISSED · CONTINUE TO THE EXIT";
      return "STOP IN THE BOX";
    }
    return "PIT LANE · 80 KM/H";
  }
  if (hud.pitPhase === "requested") return hud.hasPitLane ? "BOX THIS LAP · ENTER THE PIT LANE" : "BOX REQUESTED";
  return "";
}
