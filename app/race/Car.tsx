"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  CuboidCollider,
  RigidBody,
  useRapier,
  useBeforePhysicsStep,
  type RapierRigidBody,
  type ContactForcePayload,
} from "@react-three/rapier";
import type Rapier from "@dimforge/rapier3d-compat";
import {
  ANGULAR_DAMPING,
  CAR_WHEELS,
  CHASSIS_HALF_EXTENTS,
  CHASSIS_MASS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
  LINEAR_DAMPING,
  OFF_TRACK_RESET_METERS,
  applyCarControls,
  applyDragImpulse,
  applyKerbRideHeights,
  applyLoadSensitiveFriction,
  applySurfaceDragImpulse,
  computeSignedForwardSpeed,
  applyVehicleStabilityTorques,
  createCarController,
  wheelGroundPositions,
  yawFromQuaternion,
  STATIC_WHEEL_LOAD_N,
} from "@/lib/physics/vehicle";
import { computeDownforceN, towDragScale } from "@/lib/physics/aero";
import { createEnergySystem, overtakeModeActive, type EnergyMode } from "@/lib/physics/energy";
import { createWeatherSystem } from "@/lib/physics/weather";
import { unwrapGap } from "@/lib/ai/racecraft";
import {
  createGearboxState,
  engineTorqueMultiplier,
  gearboxSpeedMs,
  rpmForGear,
  IDLE_RPM,
  REDLINE_RPM,
  SHIFT_UP_RPM,
  isReverse,
} from "@/lib/physics/gearbox";
import {
  applyComponentDamage,
  classifyHit,
  copyDamageState,
  createDamageState,
  damageAggregate,
  damageDownforceScale,
  damageRepairSeconds,
  damageWheelGrips,
  type DamageState,
} from "@/lib/physics/damage";
import { loadDamageMode } from "@/lib/settings/damagePref";
import {
  WHEEL_ORDER,
  emptyTelemetrySample,
  slipAngleDeg,
  type TelemetrySample,
} from "@/lib/race/telemetry";
import { useDriveInput, type CameraMode, type DriveInput } from "@/lib/input/useDriveInput";
import type { TouchDriveInput } from "@/lib/input/touch";
import { createLapTimer, formatLapTime, LINE_HALF_WIDTH_METERS, standingsLapCount, type LapTimerState } from "@/lib/race/lapTimer";
import { createProgressTracker, trackProgress } from "@/lib/race/progressTracker";
import { DEFAULT_RACE_LAPS, retargetSessionUrl, type QualifyingFormat, type SessionMode } from "@/lib/race/sessionSetup";
import { isSaveableTimeAttackLap, submitTimeAttackLap } from "@/lib/race/timeAttackBoard";
import { resolveClientId } from "@/lib/race/leaderboard";
import { loadAccountSession, refreshSession, saveAccountSession } from "@/lib/race/authClient";
import { sessionNeedsRefresh, type AccountSession } from "@/lib/race/accounts";
import { DEFAULT_TEAM_ID } from "@/lib/race/rosterData";
import { TRACKS } from "@/lib/tracks/registry";
import type { CarPose } from "@/lib/net/snapshots";
import { gridSlot } from "@/lib/race/grid";
import { createDeltaTracker } from "@/lib/race/deltaTimer";
import { pushHudEvent, queueEngineerLine, tyreWear01, type HudSnapshot, type QualifyingRow } from "@/lib/race/hud";
import { classifyRace, createFinishTracker, updateFinishTracker } from "@/lib/race/classification";
import { createGhostRecorder } from "@/lib/race/ghostRecorder";
import { createSectorTimer, type SectorCrossing } from "@/lib/race/sectorTimer";
import {
  createTrackLimitSequence,
  resetTrackLimitLap,
  resetTrackLimitSequence,
  trackLimitPenaltyLabel,
  trackLimitStageLabel,
  updateTrackLimitSequence,
} from "@/lib/race/trackLimitSequence";
import { computeRacePositions, buildTowerEntries, towerOpponents, type RaceProgress, type RaceState } from "@/lib/race/racePosition";
import { polePosition, createQualifyingSession, playerGridSpot as gridSpotFromSession, qualifyingLeaderboard, sessionGridOrder, recordQualiLap, tickQualifyingSession, isQualifyingLapValid, type QualifyingTimes } from "@/lib/race/qualifying";
import { createFlagState, flagChipText, stepFlags } from "@/lib/race/flags";
import {
  createOvertakePenaltyState,
  overtakeEngineerLine,
  overtakePenaltyLabel,
  overtakePenaltyMessage,
  overtakePenaltyText,
  stepOvertakePenalties,
  type OvertakeRestriction,
} from "@/lib/race/overtakePenalties";
import { flashbackLabel, MIN_FLASHBACK_SECONDS } from "@/lib/race/flashbacks";
import {
  cancelFlashbackTimeline,
  confirmFlashbackTimeline,
  createFlashbackTimeline,
  createFlashbackTrace,
  isFlashbackTimelineOpen,
  openFlashbackTimeline,
  SCRUB_STEP_SECONDS,
  scrubFlashbackTimeline,
  type FlashbackTimelineExit,
} from "@/lib/race/flashbackTimeline";

/** Chassis contact force, N, above which a hit is marked on the strip. */
const FLASHBACK_CONTACT_FORCE_N = 9000;
import { createRewindBuffer, REWIND_CAPACITY_SECONDS, snapshotOf, applySnapshot, type RewindSample } from "@/lib/race/rewindBuffer";
import { loadPersonalBest, savePersonalBest } from "@/lib/persistence/personalBests";
import { loadSeason, recordChampionshipPractice, recordChampionshipQuali, recordChampionshipResult, recordChampionshipSprint } from "@/lib/persistence/championship";
import { pointsForPosition } from "@/lib/race/championship";
import {
  allWheelsOffTrack,
  checkTrackLimits,
  worldEdgeResetMeters,
} from "@/lib/tracks/trackLimits";
import { sampleWheelSurfaces } from "@/lib/tracks/surfaces";
import { computeSectorGates } from "@/lib/tracks/sectors";
import { createOvertakeSystem, OVERTAKE_BOOST_MULTIPLIER } from "@/lib/physics/overtake";
import { createStrategySystem } from "@/lib/race/strategy";
import { createReplayController, REPLAY_CAPACITY_SECONDS, type SharedReplay, type TelemetryFrame } from "@/lib/race/replay";
import type { RaceControlHandle, RaceOpsCommand, RaceOpsSnapshot, WeatherHandle } from "@/lib/race/raceOps";
import { createRaceControlSystem } from "@/lib/race/raceControl";
import { weatherLabel } from "@/lib/physics/weather";
import { weatherGripForCompound } from "@/lib/physics/tireModel";
import {
  GATE_COUNT,
  PROGRAMME_LABELS,
  buildGates,
  createProgrammeState,
  programmeSummary,
  recordProgrammeLap,
  stepGates,
  type ProgrammeId,
  type ProgrammeState,
} from "@/lib/race/practiceProgrammes";
import { PROGRAMME_GAIN } from "@/lib/race/objectives";
import { getRacingLine } from "@/lib/tracks/racingLineCache";
import { createWheelTemps, stepWheelTemps } from "@/lib/race/wheelTemps";
import { catchUpBonusMs, gapAheadMeters as roadGapAheadMeters, safetyCarCapMs, type SafetyCarState } from "@/lib/race/safetyCar";
import { createServeState, queuePenalty, servePrompt, stepServe } from "@/lib/race/penaltyServing";
import {
  createPitReleaseState,
  pitReleaseHint,
  stepPitRelease,
} from "@/lib/race/pitRelease";
import { formatKeyCode, getBindings } from "@/lib/input/keyBindings";
import { loadPitReleaseEnabled, subscribePitReleaseEnabled } from "@/lib/settings/pitReleasePref";
import { getPitLane, PIT_BOX_HALF_LENGTH, PIT_SPEED_LIMIT_MS, pitGateHalfWidth, pitLaneStatus } from "@/lib/tracks/pitLane";
import type { TrackData } from "@/lib/tracks/types";
import type { TowerDriver } from "@/lib/race/racePosition";
import {
  DEFAULT_CAR_SETUP,
  setupDownforceScale,
  setupDragScale,
  setupFinalDriveScale,
  TYRE_PRESSURE_NOMINAL,
  type CarSetup,
} from "@/lib/physics/carSetup";
import { computeTireWarmth, tyrePressureGripScale } from "@/lib/physics/tireModel";
import { F1CarBody } from "./F1CarBody";
import type { FxBus } from "./TrackFx";
import { HelmetCockpit, SteeringWheel } from "./CarBodyMesh";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import { impactGain01, limiterAmount, rpmTo01, skidAmount01 } from "@/lib/audio/raceAudio";
import { FLAP_OPEN_RAD, steeringWheelAngle, stepFlapAngle } from "@/lib/race/carBody";

const SECTOR_COUNT = 3;
/** Rear (driven) wheels, where skid marks are laid. */
const REAR_WHEELS = CAR_WHEELS.flatMap((wheel, i) => (wheel.isSteering ? [] : [i]));

function qualifyingColor(value: string | undefined): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#7d8795";
}

/** The qualifying classification for the results screen: every car's best,
 * with gaps to the player's lap when they set one, else to pole. */
function qualifyingRows({
  times,
  playerCode,
  playerName,
  playerColor,
  rivals,
}: {
  times: QualifyingTimes;
  playerCode: string;
  playerName: string;
  playerColor: string;
  rivals: readonly TowerDriver[];
}): QualifyingRow[] {
  const rivalByCode = new Map(rivals.map((rival) => [rival.code, rival]));
  return qualifyingLeaderboard(
    times,
    playerCode,
    rivals.map((rival) => rival.code)
  ).map((entry) => {
    const rival = entry.isPlayer ? null : rivalByCode.get(entry.code);
    return {
      position: entry.position,
      code: entry.isPlayer ? playerCode : entry.code,
      name: entry.isPlayer ? playerName : (rival?.name ?? null),
      color: qualifyingColor(entry.isPlayer ? playerColor : rival?.color),
      isPlayer: entry.isPlayer,
      time: entry.time,
      gap: times.player === null ? entry.gapToLeaderSeconds : entry.gapToPlayerSeconds,
    };
  });
}

// Plan section 7 (Grand Prix mode): a Quick Race is N laps against the one
// AI opponent that exists today. Lap count comes from the home-screen
// session-setup slider (lib/race/sessionSetup.ts, plan section 8) via the
// ?laps= URL param it drives; the param stays as a direct-entry/shared-
// link affordance.
// Plan section 5 depth feature 7: "all four wheels off at a corner exit ->
// lap invalidation (time trial) or warning -> time penalty (race)". This
// project has no separate mode selection - every drive tracks a personal
// best AND runs a Quick Race at once - so both consequences apply
// independently off the same violation rather than one suppressing the
// other (see the ponytail note at the call site for what this doesn't do).
/** Cool-down between the player taking the flag and the results screen. */
const RESULTS_DELAY_SECONDS = 4;
/**
 * The circuits a time-attack lap may be filed under, for the submission gate.
 * Module scope so it is built once rather than on every saved lap. The registry
 * is the light one - names and ids only, no geometry - so this costs nothing
 * the race page does not already carry.
 */
const TIME_ATTACK_TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));

export function Car({
  /**
   * The player's car build (see lib/physics/carSetup.ts). Defaults to the
   * neutral setup so every other embed of <Car> is unchanged.
   */
  carSetup = DEFAULT_CAR_SETUP,
  onFlashbackTimelineOpenChange,
  chassisRef,
  visualRef,
  cameraModeRef,
  racingLineVisibleRef,
  raceRef,
  hudRef,
  fxRef,
  flashbackLimit = null,
  raceLaps = DEFAULT_RACE_LAPS,
  champRound = null,
  sprint = false,
  safetyCarRef,
  practiceTargetSeconds = null,
  sessionMode = "race",
  qualiFormat = "timed",
  timeAttack = false,
  playerGridSpot = null,
  playerCode = "YOU",
  playerName = "YOU",
  playerNumber,
  playerTeamId,
  rivals = [],
  playerInputRef,
  carPosesRef,
  trafficRef,
  trafficKey,
  netResultRef,
  netActive = false,
  netSlot = 0,
  raceStartRef,
  sharedRewindActiveRef,
  sharedReplayRef,
  touchInputRef,
  qualifyingRef,
  track,
  bodyColor = "#39ff88",
  accentColor,
  audioRef,
  weatherRef,
  raceControlRef,
  raceCommandsRef,
  raceOpsSnapshotRef,
  telemetryRef,
}: {
  /**
   * The player's car build (see lib/physics/carSetup.ts). Optional, defaulting
   * to the neutral setup, so any other embed of <Car> is unchanged.
   */
  carSetup?: CarSetup;
  chassisRef: React.RefObject<RapierRigidBody | null>;
  /**
   * A ref to the car body group itself, not the physics body - see its usage
   * site in Scene.tsx for why the chase camera needs this instead of
   * chassisRef.
   */
  visualRef?: React.RefObject<THREE.Group | null>;
  /**
   * Shared with Scene.tsx's camera component (see useDriveInput's own
   * comment for why) - created there and passed down so both this
   * component's keyboard handling and the camera outside it read the same
   * ref.
   */
  cameraModeRef?: React.RefObject<CameraMode>;
  /** Shared with Track.tsx's racing line overlay - same sharing reason as cameraModeRef. */
  racingLineVisibleRef?: React.RefObject<boolean>;
  /**
   * Shared with AICar.tsx (created in Scene.tsx) - each car writes its own
   * lap/progress into its own slot of this plain mutable object every
   * physics tick, so this component can rank the full field for a live
   * position without either car needing a ref to the other's internals.
   */
  raceRef?: React.RefObject<RaceState>;
  /** The HUD's data (see lib/race/hud.ts): written here, drawn by app/race/hud/. */
  hudRef?: React.RefObject<HudSnapshot>;
  /** Skid-mark stamps for TrackFx (Scene.tsx). */
  fxRef?: React.RefObject<FxBus>;
  /** Flashbacks allowed this session (lib/race/flashbacks.ts); null = unlimited. */
  flashbackLimit?: number | null;
  /**
   * Called when the flashback timeline opens or closes. The race page uses
   * this to pause the simulation, because the timeline's own logic has to run
   * from useFrame - which does keep running while `<Physics paused>` is set,
   * whereas useBeforePhysicsStep does not, so the scrub cannot live in the
   * physics step.
   */
  onFlashbackTimelineOpenChange?: (open: boolean) => void;
  /** Quick Race lap count - see page.tsx's ?laps= URL param. */
  raceLaps?: number;
  /**
   * Championship round index from page.tsx's ?champ= param, or null for a
   * one-off race. When set, finishing writes the player's position into the
   * active season (see recordChampionshipResult).
   */
  champRound?: number | null;
  /** Championship sprint: scored 8-1, filed as the round's sprint result. */
  sprint?: boolean;
  /** Safety car / VSC state (Scene.tsx): the player is held to its speed ceiling. */
  safetyCarRef?: React.RefObject<SafetyCarState>;
  /** Championship practice: the lap time the qualifying-pace programme asks for. */
  practiceTargetSeconds?: number | null;
  /** Session kind from ?mode= (default race) - practice is solo free
   * driving, qualifying sets a grid, race is wheel-to-wheel. */
  sessionMode?: SessionMode;
  /** Qualifying format from ?qformat= (default timed). */
  qualiFormat?: QualifyingFormat;
  /**
   * Time attack from ?ta=1: a qualifying session with no clock, where every
   * lap that beats the player's own best is saved to the public board.
   *
   * A flag on qualifying rather than a fourth session mode, so it inherits the
   * whole best-lap and validity machinery unchanged. It changes exactly two
   * things: the session never finishes and no time runs down, and a completed
   * lap that improves the personal best is written to the board.
   */
  timeAttack?: boolean;
  /**
   * The player's grid spot from ?grid= (1-based), or null for a staggered
   * start from pole. Every other slot goes to the rivals in order.
   */
  playerGridSpot?: number | null;
  /** The player's FIA code for the tower (see page.tsx's roster pick). */
  playerCode?: string;
  /** Driver identity shown in the broadcast timing tower. */
  playerName?: string;
  playerNumber?: number;
  playerTeamId?: string;
  /**
   * Net-room telemetry taps (plan section 16) - all owned by Scene.tsx:
   * playerInputRef carries this car's gated inputs for the guest upload,
   * carPosesRef collects every simulated car by grid slot for the host
   * broadcast, netResultRef carries the host's authoritative finishing
   * order (guests show it instead of their locally computed one), and
   * netActive marks a net room (championship never scores net exhibitions,
   * on any side).
   */
  playerInputRef?: React.RefObject<{ throttle: number; brake: number; steer: number } | null>;
  carPosesRef?: React.RefObject<Record<number, CarPose>>;
  /**
   * Live traffic table (see Scene.tsx): this car reports its world
   * position here every physics tick under trafficKey, so AI rivals can
   * see where it actually sits when slow or stopped.
   */
  trafficRef?: React.RefObject<Record<string, { x: number; z: number }>>;
  trafficKey?: string;
  netResultRef?: React.RefObject<{ positions: Record<string, number>; winnerCode: string } | null>;
  netActive?: boolean;
  /**
   * This car's grid slot (0-based, see page.tsx's playerSlot): the key
   * into the host's slot-keyed finishing board (see netResultRef).
   */
  netSlot?: number;
  /**
   * The rivals in field order (see resolveFieldRoster): code + livery per
   * car for the tower, and the count sizes the qualifying session. Fixed
   * per mount (page.tsx remounts Scene when it changes).
   */
  rivals?: TowerDriver[];
  /**
   * Grid start (Scene.tsx's RaceStartCountdown) - throttle is locked out
   * while false. Undefined behaves as already-started (no countdown), so
   * this stays optional for anything that mounts Car.tsx without Scene's
   * countdown wiring.
   */
  raceStartRef?: React.RefObject<boolean>;
  /**
   * Owned by Scene.tsx, written here and read by AICar.tsx: true while the
   * player holds the rewind key, so every car scrubs the same timeline.
   * The player advances the shared cursor (see rewindCursorRef); each AI
   * keeps its own cursor in lockstep from the same flag, so no ordering
   * between the two physics steps matters.
   */
  sharedRewindActiveRef?: React.RefObject<boolean>;
  /**
   * Owned by Scene.tsx, written here and read by AICar.tsx: while instant
   * replay plays, every AI car shows its own pose from `secondsBack` behind
   * live instead of simulating, and snaps back to live when it ends.
   */
  sharedReplayRef?: React.RefObject<SharedReplay>;
  /** Shared mutable analog controls from the on-screen touch deck. */
  touchInputRef?: React.RefObject<TouchDriveInput | null>;
  /** Playable Qualifying (see lib/race/qualifying.ts) - shared with AICar.tsx. */
  qualifyingRef?: React.RefObject<QualifyingTimes>;
  track: TrackData;
  /** Garage pick (see lib/race/roster.ts) - the team's primary livery. */
  bodyColor?: string;
  /** The team's secondary livery (see page.tsx) - the stripe accent; the
   * shared shell derives one from the primary when none is passed. */
  accentColor?: string;
  /** Shared with the race audio rig (see app/race/RaceAudioRig.tsx) - this
   * car fills in the player half every render frame from live telemetry. */
  audioRef?: React.RefObject<AudioSnapshot>;
  weatherRef?: React.RefObject<WeatherHandle>;
  raceControlRef?: React.RefObject<RaceControlHandle>;
  raceCommandsRef?: React.RefObject<RaceOpsCommand[]>;
  raceOpsSnapshotRef?: React.RefObject<RaceOpsSnapshot | null>;
  /**
   * Live telemetry for the engineer overlay (see lib/race/telemetry.ts and
   * app/race/TelemetryPanel.tsx). Optional: the car fills it in place every
   * physics step and the panel reads it on its own rAF, so no re-render is
   * involved. Omitted when the overlay is closed, which also skips the
   * per-step work entirely.
   */
  telemetryRef?: React.RefObject<TelemetrySample | null>;
}) {
  const { startPos } = track;
  // Grid slot for this car (see grid.ts) - pole at the line, everyone
  // else staggered back in rows, with each behind car's timer forgiving
  // the run to the line; null starts staggered from pole.
  const gridSpot = useMemo(
    () => gridSlot(track, (playerGridSpot ?? 1) - 1),
    [track, playerGridSpot]
  );
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(
    null
  );
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const steeringWheelRef = useRef<THREE.Group | null>(null);
  // Dashboard/cockpit rails drawn only in helmet view, as a sibling of the
  // hidden-chassis group so the camera still sees them.
  const helmetCockpitRef = useRef<THREE.Group | null>(null);
  // The setup's aero multipliers, resolved once per render (both are pure
  // functions of the prop). The player's car only - the AI runs the neutral
  // setup so every stability gate stays a measurement of what it measured.
  const setupDown = setupDownforceScale(carSetup);
  const setupDrag = setupDragScale(carSetup);
  // The final drive (a gearbox ratio multiplier) and the tyre-pressure grip
  // scale, both pure functions of the setup and both resolved once per
  // render. Player's car only - the AI runs DEFAULT_CAR_SETUP, so this
  // resolves to 1 / neutral there and every AI gate is unaffected.
  const setupFinalDrive = setupFinalDriveScale(carSetup);
  // Pressure is re-resolved each physics step against the live tyre
  // temperature (below), so it is the pressure VALUE that is fixed here and
  // the grip scale that is read per step - the warm-up half of the slider has
  // to vary over a stint, so it cannot be a render-time constant.
  const setupPressure = carSetup.tyrePressure ?? TYRE_PRESSURE_NOMINAL;
  // Rear-wing flap pivot (see app/race/F1CarBody.tsx) - rotated open in
  // low-drag mode, like the real active-aero flap.
  const flapRef = useRef<THREE.Group | null>(null);
  const { world, rapier } = useRapier();
  const { update, input, clearRewindReleased, aeroMode, cameraMode, tireCompound, tractionControlEnabled, absEnabled, racingLineVisible, autoGear, gamepadConnected } =
    useDriveInput(cameraModeRef, racingLineVisibleRef, touchInputRef);
  // Plan section 5 depth feature 4 (manual gears): one persistent gearbox
  // per car. `auto` follows the autoGear toggle (synced each physics tick
  // below) so the HUD and drive model always agree with the assist state.
  // Seeded with the player's final drive, so the ratio that moves the shift
  // point is the same one the torque curve reads (see
  // lib/physics/gearbox.ts's FINAL_DRIVE_MIN). AI cars leave the default, so
  // the AI keeps the exact gearing every stability gate was measured with.
  const gearboxRef = useRef(createGearboxState(true, setupFinalDrive));
  const shiftSerialRef = useRef(0);
  const lapTimerRef = useRef(
    createLapTimer({
      startPos,
      lineHalfWidth: pitGateHalfWidth(track, LINE_HALF_WIDTH_METERS),
      startsBehindLine: gridSpot.startsBehindLine,
    })
  );
  const raceElapsedSecondsRef = useRef(0);
  const raceFinishedRef = useRef(false);
  // Non-race sessions (plan section 8): the player's own qualifying
  // machine (best valid lap per the session rules in qualifying.ts) and a
  // latch so the end-of-session banner + persistence fire exactly once.
  // Practice reuses raceFinishedRef (laps reached) rather than growing a
  // third flag.
  const qualiSessionRef = useRef(createQualifyingSession(qualiFormat, rivals.length));
  const qualiFinishedRef = useRef(false);
  // Tower repaint throttle: rows rebuild at a real ~10Hz. A frame counter
  // would run faster on a 144Hz display, so keep an elapsed-time clock.
  const towerClockRef = useRef(0);
  const skidTravelRef = useRef(0);
  const inPitLaneRef = useRef(false);
  const flagStateRef = useRef(createFlagState(rivals.length));
  // Overtaking-under-a-flag race control (lib/race/overtakePenalties.ts).
  // Player only, and read-only over the race progress: it never steers or
  // slows a car, so the AI is untouched and the stability gates stay valid.
  const overtakePenaltyRef = useRef(createOvertakePenaltyState(rivals.length));
  const pitBoxMetersRef = useRef<number | null>(null);
  // Drive-through / stop-go waiting to be served in the pit lane.
  const serveRef = useRef(createServeState());
  // The driver's half of a stop: the lollipop going green and the release
  // window that follows it (see lib/race/pitRelease.ts). Player-only and
  // cosmetic - the outcome moves the race clock by a few tenths and nothing
  // else, so no AI behaviour is anywhere near this code.
  const pitReleaseRef = useRef(createPitReleaseState());
  // Read once per session and re-read when the pause-menu setting changes,
  // so turning it off mid-session takes effect at the next stop rather than
  // needing a reload.
  const pitReleaseEnabledRef = useRef(loadPitReleaseEnabled());
  useEffect(() => {
    pitReleaseEnabledRef.current = loadPitReleaseEnabled();
    return subscribePitReleaseEnabled(() => {
      pitReleaseEnabledRef.current = loadPitReleaseEnabled();
    });
  }, []);
  // Championship practice programmes (see lib/race/practiceProgrammes.ts):
  // gates on the racing line, lap consistency, and a qualifying-pace target.
  const programmesActive = sessionMode === "practice" && champRound !== null;
  const gatesRef = useRef<ReturnType<typeof buildGates>>([]);
  const programmeRef = useRef<ProgrammeState | null>(null);
  const programmeHitsRef = useRef(-1);
  useEffect(() => {
    if (!programmesActive) return;
    const gates = buildGates(getRacingLine(track));
    const state = createProgrammeState(GATE_COUNT, practiceTargetSeconds);
    gatesRef.current = gates;
    programmeRef.current = state;
    if (hudRef?.current) {
      hudRef.current.gates = gates;
      hudRef.current.gateHits = state.gateHits;
      hudRef.current.programmeText = programmeSummary(state);
    }
    // Programmes already banked earlier in the weekend stay ticked.
    let cancelled = false;
    loadSeason()
      .then((season) => {
        const done = season?.rounds[champRound ?? -1]?.practice;
        if (cancelled || !done) return;
        for (const id of Object.keys(done) as ProgrammeId[]) state.done[id] = true;
        programmeHitsRef.current = -1;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // The session is fixed for this mount (the scene remounts on any change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const completeProgramme = (id: ProgrammeId) => {
    if (hudRef?.current) {
      pushHudEvent(hudRef.current, "good", `${PROGRAMME_LABELS[id].toUpperCase()} COMPLETE`, `+${PROGRAMME_GAIN} REPUTATION`, 3.5);
    }
    if (champRound !== null) recordChampionshipPractice(champRound, id).catch(() => {});
    programmeHitsRef.current = -1;
  };
  const wheelTempsRef = useRef(createWheelTemps());
  const wheelGripsRef = useRef<readonly number[]>([]);
  // Race finish (see lib/race/classification.ts): the race clock without
  // penalties, the per-car flag state, and when the results go up.
  const raceClockRef = useRef(0);
  const finishTrackerRef = useRef(createFinishTracker(rivals.length + 1));
  const resultsAtClockRef = useRef<number | null>(null);
  // Race clock timestamp (not lap-relative currentLapSeconds, which resets
  // every lap and could strand the toast if a penalty lands late in a lap)
  // to hide the penalty toast at.
  const qualifyingDisplayedRef = useRef(false);
  const bestLapRef = useRef<number | null>(null);
  // Time attack: the signed-in player, read from storage once. The race route
  // is a fresh page load, so this is where an account picked up on the landing
  // page becomes known - and reading it lazily here means a race with no
  // account never touches storage at all.
  const timeAttackSessionRef = useRef<AccountSession | null | undefined>(undefined);
  const timeAttackClientIdRef = useRef<string | null | undefined>(undefined);

  /**
   * Saves one time-attack lap to the board. Never throws and never blocks.
   *
   * The session is refreshed first when it is close to expiry, so a lap
   * cannot start with a valid token and lose the row to a refresh landing
   * first. A refresh that fails falls back to an ANONYMOUS save rather than
   * dropping the lap: the time is the thing the player earned, and an
   * unattributed row on a public board is a much better outcome than a lost
   * one.
   */
  const saveTimeAttackLap = useCallback(
    (lapMs: number, trackId: string) => {
      // undefined means "not read yet", which is why the ref's own type carries
      // it - and why the value is copied into a local, because TypeScript
      // cannot see that the assignment above already happened through the ref.
      if (timeAttackSessionRef.current === undefined) {
        timeAttackSessionRef.current = loadAccountSession();
      }
      const stored: AccountSession | null = timeAttackSessionRef.current ?? null;
      const send = (session: AccountSession | null) => {
        if (timeAttackClientIdRef.current === undefined) {
          try {
            timeAttackClientIdRef.current = resolveClientId(window.localStorage);
          } catch {
            timeAttackClientIdRef.current = null;
          }
        }
        return submitTimeAttackLap({
          trackId,
          lapMs,
          driverCode: playerCode,
          teamId: playerTeamId ?? DEFAULT_TEAM_ID,
          session,
          clientId: timeAttackClientIdRef.current,
          knownTrackIds: TIME_ATTACK_TRACK_IDS,
        });
      };
      if (stored === null || !sessionNeedsRefresh(stored, Date.now())) {
        void send(stored);
        return;
      }
      void refreshSession(stored).then((result) => {
        if (result.ok && result.session !== null) {
          timeAttackSessionRef.current = result.session;
          saveAccountSession(result.session);
          void send(result.session);
        } else {
          // The account could not be refreshed, so it is no longer a usable
          // identity - but the lap still counts. Stash the failure so the next
          // save does not try the same dead token again.
          timeAttackSessionRef.current = null;
          void send(null);
        }
      });
    },
    [playerCode, playerTeamId]
  );
  const deltaTrackerRef = useRef(createDeltaTracker());
  // Set whenever this lap's progress jumped discontinuously (a rewind, or
  // the off-track teleport below) instead of driving forward continuously -
  // such a lap's recorded (progress, time) samples aren't monotonic, so it
  // must never be adopted as the delta tracker's reference lap even if it
  // happens to also be a new best time (recordSample/endLap in
  // lib/race/deltaTimer.ts assume monotonic progress within a recording).
  // Reset after every lap ends, tainting only the lap it happened in.
  const lapHadDiscontinuityRef = useRef(false);
  // Plan section 5, depth feature 7: a lap is invalidated once all four
  // wheels have been off track at any point - and the real-time HUD
  // warning above fires on that same all-four rule (see allWheelsOffTrack),
  // never on the merely-wide chassis-center position. Reset alongside
  // lapHadDiscontinuityRef when the next lap starts.
  const lapInvalidRef = useRef(false);
  // The lap clock's value (lap.currentLapSeconds) at the moment
  // lapInvalidRef first became true this lap - lets the rewind-resume
  // handler below tell whether a rewind reached back far enough to undo
  // the actual violation, not just any rewind at all (which would let an
  // unrelated later correction erase an earlier, still-valid infraction).
  const lapInvalidAtSecondsRef = useRef<number | null>(null);
  // Qualifying can accept a lap after a rewind once the underlying track-limit
  // violation has been undone. Keep the general continuity flag for the delta
  // and ghost systems, but use this timing-specific flag for the result.
  const qualifyingDiscontinuityRef = useRef(false);
  const sectorTimerRef = useRef(createSectorTimer(computeSectorGates(track, SECTOR_COUNT)));
  const trackLimitSequenceRef = useRef(createTrackLimitSequence());
  const sectorResultsRef = useRef<(SectorCrossing | null)[]>(
    new Array(SECTOR_COUNT).fill(null)
  );
  const ghostRecorderRef = useRef(createGhostRecorder());
  // Progress continuity (see progressTracker.ts): rank and racecraft
  // read tracked progress, never the flicker-prone scan, at the seam.
  const progressTrackerRef = useRef(createProgressTracker());
  // Ghost replay (see F1CarBody's ghost prop): the reference lap driven
  // back as a translucent silhouette of the real car, posed every frame
  // from the recorder - wheels parked, since a replay needs no steering.
  const ghostGroupRef = useRef<THREE.Group>(null);
  const ghostSteerRefs = useRef<(THREE.Group | null)[]>([]);
  const ghostSpinRefs = useRef<(THREE.Group | null)[]>([]);
  // Share of wheels on a kerb this physics tick, for the audio rumble.
  const kerbContactRef = useRef(0);
  // Grip lost to impact damage (1 = undamaged) - see applyImpactDamage's own
  // comment. Reset on the same "fresh attempt" triggers as the lap-scoped
  // state below: a new lap starting, or the off-track/world-edge teleport
  // reset snapping the car back to the start line.
  const damageGripMultiplierRef = useRef(1);
  // Component damage (lib/physics/damage.ts): which parts are broken, the
  // per-wheel grip and downforce that follow from them, and how many hits
  // this session (it varies which wing a side hit clips).
  const damageRef = useRef(createDamageState());
  // Dev builds only: lets a headless check break the wings on demand.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __liftDamage?: React.RefObject<DamageState> }).__liftDamage = damageRef;
    (window as unknown as { __liftServe?: React.RefObject<ReturnType<typeof createServeState>> }).__liftServe = serveRef;
  }, []);
  const damageGripsRef = useRef<number[]>([1, 1, 1, 1]);
  const damageDownforceRef = useRef(1);
  const hitCountRef = useRef(0);
  const damageModeRef = useRef(loadDamageMode());
  // Recomputes everything derived from the damage state; call after any change.
  const setDamage = (next: DamageState) => {
    if (next !== damageRef.current) copyDamageState(next, damageRef.current);
    damageWheelGrips(damageRef.current, damageGripsRef.current);
    damageDownforceRef.current = damageDownforceScale(damageRef.current);
    damageGripMultiplierRef.current = damageAggregate(damageRef.current);
  };
  useEffect(() => {
    let cancelled = false;
    loadPersonalBest(track.id)
      .then((record) => {
        if (cancelled || !record) return;
        bestLapRef.current = record.bestLapSeconds;
        if (record.ghost.length > 0) ghostRecorderRef.current.setReference(record.ghost);
      })
      .catch(() => {});
    // Shows "S1 --.---  S2 --.---  S3 --.---" from the very start of the
    // session, rather than a blank/hidden HUD element (.sectors:empty)
    // until the first sector completes.
    renderSectors();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  const rewindBufferRef = useRef(createRewindBuffer(REWIND_CAPACITY_SECONDS, 1 / 60));
  const rewindCursorRef = useRef(0);
  const flashbacksLeftRef = useRef<number | null>(flashbackLimit);
  const noFlashbackToldRef = useRef(false);
  // The flashback timeline (lib/race/flashbackTimeline.ts): a paused scrub
  // over the last REWIND_CAPACITY_SECONDS, plus the cheap numeric trace the
  // strip is drawn from. The trace is the deliberate stand-in for the F1
  // game's film frames - see the module header on why there are no
  // thumbnails.
  const flashbackTimelineRef = useRef(createFlashbackTimeline());
  const flashbackTraceRef = useRef(createFlashbackTrace());
  /** Latched by a collision, consumed by the next 10Hz trace sample. */
  const flashbackContactRef = useRef(false);
  /**
   * The pose the car was in when the timeline opened, so a CANCEL can put it
   * back exactly. The scrub itself previews poses by writing straight to the
   * body, which means without this a cancel would leave the car frozen
   * somewhere in its own past with the race still paused.
   */
  const savedPoseRef = useRef<RewindSample | null>(null);
  /**
   * Keys the timeline reads itself, in the CAPTURE phase, attached only while
   * it is open.
   *
   * Why not the shared input: the physics step is paused while the timeline is
   * open, so useDriveInput's update() has to be pumped by hand from useFrame -
   * which works for the arrow keys but not reliably for Escape, because other
   * components listen for it too (page.tsx opens the pause menu,
   * ControlSettingsPanel cancels with it) and one of them can consume the
   * event first. A capture-phase listener on window runs before every bubble
   * listener on the page, so nothing else can take the key from it, and
   * stopPropagation cannot help it either.
   */
  const timelineKeysRef = useRef<{ scrubBack: boolean; scrubForward: boolean; confirm: boolean; cancel: boolean } | null>(
    null
  );
  const timelineKeysDetachRef = useRef<(() => void) | null>(null);
  const wasRewindingRef = useRef(false);
  const isRewindingRef = useRef(false);
  const lapTimerPrimedRef = useRef(false);

  const energySystemRef = useRef(createEnergySystem());
  const batteryFractionRef = useRef(1);
  const ersModeRef = useRef<EnergyMode>("balanced");
  const localWeatherRef = useRef<WeatherHandle>(createWeatherSystem("clear"));
  const effectiveWeatherRef = weatherRef ?? localWeatherRef;
  const localRaceControlRef = useRef<RaceControlHandle>(createRaceControlSystem());
  const effectiveRaceControlRef = raceControlRef ?? localRaceControlRef;
  // The player's tyre pressure reaches the strategy system as its WARM-UP
  // half: it changes the carcass thermal time constant, which is what makes
  // the low-pressure end slow to arrive and the high-pressure end quick
  // (see lib/physics/tireModel.ts). The grip half is applied per physics step
  // above. Undefined for the AI, so every AI car keeps the neutral constant.
  const strategyRef = useRef(createStrategySystem({ tyrePressure: carSetup.tyrePressure }));
  const overtakeSystem = useMemo(
    () => createOvertakeSystem(track, sessionMode),
    [track, sessionMode]
  );
  const replayRef = useRef(createReplayController(REPLAY_CAPACITY_SECONDS, 1 / 60));
  const replayActiveRef = useRef(false);
  const replayCameraRestoreRef = useRef<CameraMode | null>(null);
  const overtakeRequestedRef = useRef(false);
  const energyStatusRef = useRef(energySystemRef.current.snapshot());
  const strategyStateRef = useRef(strategyRef.current.snapshot());
  const overtakeStateRef = useRef(overtakeSystem.snapshot());
  const weatherStateRef = useRef(effectiveWeatherRef.current.snapshot());
  const startRotationRef = useRef(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, gridSpot.headingRad, 0))
  );

  useEffect(() => {
    const body = chassisRef.current;
    if (!body) return;
    const controller = createCarController(rapier, world, body);
    controllerRef.current = controller;
    return () => {
      world.removeVehicleController(controller);
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rapier, world]);

  // Diagnostic hook, kept deliberately: runs a batch of physics steps
  // synchronously against the real mounted world/controller/chassis,
  // bypassing the render loop entirely. In the Claude Code browser
  // automation used to build this, requestAnimationFrame and
  // ResizeObserver never fire, so this - plus dispatching a plain
  // `resize` event on window once to unstick react-use-measure's initial
  // container measurement, which is what the Canvas mount itself is
  // gated on - is the only way to mount the scene and then inspect the
  // live game's actual physics state from there. This is how the wheel
  // mesh auto-collider bug below was actually found: the headless Node
  // harness has no meshes at all and could never have seen it.
  useEffect(() => {
    function handleDebugDrive(event: Event) {
      const controller = controllerRef.current;
      const body = chassisRef.current;
      const output = document.getElementById("__debug-output");
      if (!controller || !body) {
        if (output) {
          output.textContent = JSON.stringify({
            error: "controller or body not ready",
            hasController: !!controller,
            hasBody: !!body,
          });
        }
        return;
      }
      if (output) output.textContent = "RUNNING";
      const detail = (event as CustomEvent).detail as {
        seconds: number;
        throttle: number;
        brake: number;
        steer: number;
        sampleEvery?: number;
      };
      const timestep = world.timestep;
      const steps = Math.round(detail.seconds / timestep);
      const sampleEvery = detail.sampleEvery ?? 30;
      const worldUp = new THREE.Vector3(0, 1, 0);
      let maxTilt = 0;
      const samples: Array<{
        t: number;
        tilt: number;
        roll: number;
        pitch: number;
        y: number;
        speed: number;
      }> = [];

      for (let i = 0; i < steps; i++) {
        // Diagnostic drive uses the auto gearbox (fixed-input thrust probe),
        // never the player's live manual selection.
        gearboxRef.current.auto = true;
        applyCarControls(
          controller,
          { throttle: detail.throttle, brake: detail.brake, steer: detail.steer },
          DEFAULT_ENGINE_FORCE,
          1,
          DEFAULT_BRAKE_FORCE,
          controller.currentVehicleSpeed(),
          true,
          { state: gearboxRef.current, shiftUp: false, shiftDown: false }
        );
        applyLoadSensitiveFriction(controller, aeroMode.current);
        controller.updateVehicle(timestep);

        applyVehicleStabilityTorques(body, DEFAULT_STABILIZE_STRENGTH, timestep);
        const downforceN = computeDownforceN(
          controller.currentVehicleSpeed(),
          aeroMode.current,
          setupDown
        );
        body.applyImpulse({ x: 0, y: -downforceN * timestep, z: 0 }, true);
        applyDragImpulse(body, aeroMode.current, timestep, setupDrag);

        world.step();

        const r = body.rotation();
        const quat = new THREE.Quaternion(r.x, r.y, r.z, r.w);
        const bodyUp = new THREE.Vector3(0, 1, 0).applyQuaternion(quat);
        const tilt = bodyUp.angleTo(worldUp);
        if (tilt > maxTilt) maxTilt = tilt;

        if (i % sampleEvery === 0) {
          const bodyRight = new THREE.Vector3(1, 0, 0).applyQuaternion(quat);
          const bodyForward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
          samples.push({
            t: Number((i * timestep).toFixed(2)),
            tilt: Number(tilt.toFixed(4)),
            roll: Number(Math.asin(Math.max(-1, Math.min(1, bodyRight.y))).toFixed(4)),
            pitch: Number(Math.asin(Math.max(-1, Math.min(1, -bodyForward.y))).toFixed(4)),
            y: Number(body.translation().y.toFixed(4)),
            speed: Number(controller.currentVehicleSpeed().toFixed(2)),
          });
        }
      }

      if (output) {
        output.textContent = JSON.stringify({ bodyMass: body.mass(), maxTilt, samples });
      }
    }

    window.addEventListener("debug-drive-request", handleDebugDrive);
    return () => window.removeEventListener("debug-drive-request", handleDebugDrive);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world]);

  function toggleReplay() {
    // Online the other cars belong to other people's machines, so there is
    // no whole-field timeline to replay and no way to freeze it.
    if (netActive) return;
    if (replayActiveRef.current) {
      stopReplay();
      return;
    }
    replayActiveRef.current = replayRef.current.togglePlayback();
    if (replayActiveRef.current) {
      replayCameraRestoreRef.current = cameraMode.current;
      cameraMode.current = "tv";
    }
  }

  /**
   * Ends instant replay however it ends (toggled, stopped from Race Ops, or
   * played out) and puts the car back exactly where it was when the replay
   * began. Without the restore, stopping midway left the car at the replayed
   * past pose - a free rewind. The AI cars restore themselves from the same
   * shared flag (see AICar.tsx).
   */
  function stopReplay() {
    replayRef.current.stopPlayback();
    replayActiveRef.current = false;
    const live = replayRef.current.liveFrame();
    const body = chassisRef.current;
    if (live && body) applySnapshot(body, live, false);
    if (sharedReplayRef) sharedReplayRef.current = { active: false, secondsBack: 0 };
    if (replayCameraRestoreRef.current) {
      cameraMode.current = replayCameraRestoreRef.current;
      replayCameraRestoreRef.current = null;
    }
  }

  function consumeRaceOpsCommands(driveInput: DriveInput) {
    if (driveInput.pitRequested) strategyRef.current.requestPit();
    if (driveInput.replayToggle) {
      toggleReplay();
    }
    if (driveInput.ersModeCycle) {
      const modes: EnergyMode[] = ["harvest", "balanced", "attack"];
      const next = modes[(modes.indexOf(ersModeRef.current) + 1) % modes.length];
      ersModeRef.current = next;
      energySystemRef.current.setMode(next);
    }
    if (driveInput.strategyModeCycle) {
      const modes = ["save", "balanced", "push"] as const;
      const current = strategyRef.current.snapshot().mode;
      strategyRef.current.setMode(modes[(modes.indexOf(current) + 1) % modes.length]);
    }
    if (driveInput.weatherCycle) {
      const presets = ["clear", "cloudy", "rain"] as const;
      const current = effectiveWeatherRef.current.snapshot().preset;
      effectiveWeatherRef.current.setPreset(presets[(presets.indexOf(current) + 1) % presets.length]);
    }
    const commands = raceCommandsRef?.current.splice(0) ?? [];
    for (const command of commands) {
      switch (command.type) {
        case "set-weather":
          effectiveWeatherRef.current.setPreset(command.preset);
          break;
        case "set-ers-mode":
          ersModeRef.current = command.mode;
          energySystemRef.current.setMode(command.mode);
          break;
        case "set-strategy-mode":
          strategyRef.current.setMode(command.mode);
          break;
        case "set-compound":
          tireCompound.current = command.compound;
          strategyRef.current.setCompound(command.compound);
          break;
        case "request-pit":
          strategyRef.current.requestPit();
          break;
        case "cancel-pit":
          strategyRef.current.cancelPit();
          break;
        case "toggle-overtake":
          overtakeRequestedRef.current = !overtakeRequestedRef.current;
          overtakeSystem.setRequested(overtakeRequestedRef.current);
          break;
        case "toggle-replay":
          toggleReplay();
          break;
        case "stop-replay":
          if (replayActiveRef.current) stopReplay();
          break;
        case "seek-replay":
          replayRef.current.seekRelative(command.seconds);
          break;
        case "report-unsafe-rejoin":
          effectiveRaceControlRef.current.reportIncident("unsafe-rejoin", raceElapsedSecondsRef.current);
          break;
      }
    }
  }

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
    const driveInput = update(world.timestep);
    consumeRaceOpsCommands(driveInput);
    if (replayActiveRef.current) {
      replayRef.current.tick(world.timestep);
      if (!replayRef.current.state().playback) {
        // Played out: back to live, and this step runs normally.
        stopReplay();
      } else {
        // The whole field freezes and replays (see sharedReplayRef): the
        // race clock, lap timer and AI all hold while the player watches, so
        // a replay can never cost track position.
        const replayFrame = replayRef.current.frameAtCursor();
        if (replayFrame) applySnapshot(body, replayFrame, true);
        if (sharedReplayRef) {
          sharedReplayRef.current = { active: true, secondsBack: replayRef.current.secondsBehindLive() };
        }
        isRewindingRef.current = true;
        return;
      }
    }
    // Flashbacks are limited in a race (see lib/race/flashbacks.ts); a hold
    // already under way is always allowed to finish.
    const flashbacksLeft = flashbacksLeftRef.current;
    const canRewind = flashbacksLeft === null || flashbacksLeft > 0 || wasRewindingRef.current;
    const rewinding = driveInput.rewind && canRewind;
    if (driveInput.rewind && !canRewind && !noFlashbackToldRef.current && hudRef) {
      noFlashbackToldRef.current = true;
      pushHudEvent(hudRef.current, "warn", "NO FLASHBACKS LEFT", undefined, 1.6);
    }
    if (!driveInput.rewind) noFlashbackToldRef.current = false;
    // The flash trace (lib/race/flashbackTimeline.ts): one call per physics
    // step, decimated to 10Hz inside, fed from the DRIVER's own throttle and
    // brake so the strip shows what was asked of the car. Recorded here rather
    // than in useFrame so the trace advances on the physics clock, not the
    // render clock - otherwise the strip and the rewind buffer would drift
    // apart on any machine that is not running at exactly 60 FPS. Costs no
    // draw calls and no allocation. Frozen while the timeline is open, since
    // the physics step is not running then anyway.
    if (!isFlashbackTimelineOpen(flashbackTimelineRef.current)) {
      flashbackTraceRef.current.record(1 / 60, {
        speedKmh: Math.abs(controller.currentVehicleSpeed()) * 3.6,
        throttle: driveInput.throttle,
        brake: driveInput.brake,
        contact: flashbackContactRef.current,
      });
      flashbackContactRef.current = false;
    }
    isRewindingRef.current = rewinding;
    if (sharedRewindActiveRef) sharedRewindActiveRef.current = rewinding;

    // Snap back to the start line if the car ends up this far off-track
    // (e.g. spun off pointing away from the circuit and held throttle
    // instead of rewinding). Found via headless testing: driving straight
    // off-course for long enough eventually runs past the finite ground
    // plane's edge and crashes the physics engine entirely - this catches it
    // hundreds of meters before that, and far past any legitimate
    // spin-recovery distance in the stability suite (under 60m throughout).
    //
    // Also checks absolute distance from the origin directly (see
    // WORLD_EDGE_RESET_METERS) - the ribbon-distance check above can't catch
    // a car that drives straight past the far end of the track's own extent,
    // since the nearest ribbon point stays fixed while the car keeps going.
    const pos = body.translation();
    if (!lapTimerPrimedRef.current) {
      lapTimerRef.current.prime({ x: pos.x, z: pos.z });
      lapTimerPrimedRef.current = true;
    }
    // Reused below for the surface grip penalty too, instead of a second
    // brute-force nearest-centerline-point scan for the same position.
    const limitStatus = checkTrackLimits(track, pos.x, pos.z, pos.y);
    // The finiteness guard is load-bearing: a dense pack can grind the
    // contact solver into NaN (seen as a frozen frame plus dead WASM on
    // 20-car Suzuka starts), and NaN spreads car-to-car within ticks - so
    // a poisoned car resets with zeroed velocities BEFORE the next step,
    // exactly like an off-track excursion, and the field never notices.
    const lv0 = body.linvel();
    const rt0 = body.rotation();
    if (
      !Number.isFinite(pos.x + pos.y + pos.z + lv0.x + lv0.y + lv0.z + rt0.x + rt0.y + rt0.z + rt0.w) ||
      limitStatus.distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > worldEdgeResetMeters(track)
    ) {
      const q = startRotationRef.current;
      // Track-relative spawn height: startPos is the start/finish line's own
      // x/z, and the elevation build normalizes that point to y=0 (see
      // scripts/build-track.mts), so 1m above it is still right.
      body.setTranslation({ x: gridSpot.x, y: gridSpot.y, z: gridSpot.z }, true);
      body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      rewindBufferRef.current.clear();
      lapTimerRef.current.prime({ x: gridSpot.x, z: gridSpot.z });
      // Clear rewind state too - otherwise a reset that lands mid-rewind
      // (holding R while 300m out, the exact situation a stranded player
      // reaches for) leaves wasRewindingRef true, and the next tick's
      // resumeFrom() teleports the car straight back out to the stale
      // pre-reset snapshot.
      wasRewindingRef.current = false;
      rewindCursorRef.current = 0;
      lapHadDiscontinuityRef.current = true;
      qualifyingDiscontinuityRef.current = true;
      // Otherwise nextGateIndex would still point at whatever gate was
      // being approached before the teleport - the car driving from the
      // start line would silently miss gate 0 and later register a
      // garbage split spanning the teleport (see sectorTimer.reset).
      sectorTimerRef.current.reset();
      setDamage(createDamageState());
      resetTrackLimitSequence(trackLimitSequenceRef.current);
      return;
    }

    if (rewinding) {
      lapHadDiscontinuityRef.current = true;
      qualifyingDiscontinuityRef.current = true;
      wasRewindingRef.current = true;
      const buffer = rewindBufferRef.current;
      rewindCursorRef.current = Math.min(
        rewindCursorRef.current + world.timestep,
        buffer.oldestAvailableSeconds()
      );
      const sample = buffer.sampleAt(rewindCursorRef.current);
      if (sample) applySnapshot(body, sample, true);
      return;
    }

    if (wasRewindingRef.current) {
      const sample = rewindBufferRef.current.resumeFrom(rewindCursorRef.current);
      if (sample) applySnapshot(body, sample, false);
      if (sample?.damageParts) setDamage(copyDamageState(sample.damageParts, createDamageState()));
      else if (sample?.damage !== undefined) damageGripMultiplierRef.current = sample.damage;
      // The rewind can move the car across the finish-line projection. Prime
      // the detector from the restored pose so its old sample cannot cause a
      // duplicate or missed crossing on the next physics/render tick.
      const rewoundPosition = body.translation();
      lapTimerRef.current.prime({ x: rewoundPosition.x, z: rewoundPosition.z });
      // Undo the mistake, not just its consequences: roll the lap clock
      // back by however much time was actually scrubbed. Only clear an
      // existing track-limits invalidation if the rollback actually
      // reaches back to (or before) the moment it happened - otherwise an
      // unrelated later rewind (e.g. straightening up after clipping a
      // kerb at turn 9) would erase an earlier, still-legitimate
      // invalidation from turn 3 just by being a rewind at all. If the
      // excursion itself is still within reach after rewinding, the very
      // next frame's allWheelsOffTrack check re-flags it immediately
      // regardless. (lapHadDiscontinuityRef is deliberately NOT cleared
      // here - it protects the delta timer/ghost recorder's recorded
      // samples, which stay non-monotonic across this rewind regardless of
      // whether the driving itself was clean afterward.)
      const rolledBackTo = lapTimerRef.current.rewindBy(rewindCursorRef.current);
      sectorTimerRef.current.rewindTo(rolledBackTo);
      if (lapInvalidAtSecondsRef.current === null || rolledBackTo <= lapInvalidAtSecondsRef.current) {
        lapInvalidRef.current = false;
        lapInvalidAtSecondsRef.current = null;
        resetTrackLimitSequence(trackLimitSequenceRef.current);
        if (sessionMode === "qualifying") qualifyingDiscontinuityRef.current = false;
      }
      if (flashbacksLeftRef.current !== null && rewindCursorRef.current >= MIN_FLASHBACK_SECONDS) {
        flashbacksLeftRef.current = Math.max(0, flashbacksLeftRef.current - 1);
        if (hudRef) {
          pushHudEvent(hudRef.current, "info", `FLASHBACK · ${flashbackLabel(flashbacksLeftRef.current)}`, undefined, 2);
        }
      }
      rewindCursorRef.current = 0;
      wasRewindingRef.current = false;
    }

    // Grid start: no throttle or Push-to-Pass before the lights (no jumped
    // starts, no battery drained into a locked driveline), and the car
    // sits on its brakes - otherwise it creeps down a sloped grid, and a
    // car that rolls back past the line arms the lap timer for a bogus
    // lap the moment it drives forward again.
    const raceStarted = raceStartRef?.current ?? true;
    const disqualified = effectiveRaceControlRef.current.snapshot().disqualified;
    let gatedDriveInput = !raceStarted || disqualified
      ? { ...driveInput, throttle: 0, deploy: false, brake: 1 }
      : driveInput;
    // Pit lane (see lib/tracks/pitLane.ts): the limiter takes the throttle
    // off and brakes gently above 80 km/h, so the lane can never be sped
    // through. The box is where a requested stop is serviced.
    const pitLane = getPitLane(track);
    const laneNow = pitLane
      ? pitLaneStatus(track, pitLane, limitStatus.nearestIndex, limitStatus.lateralMeters)
      : { inLane: false, boxAheadMeters: null };
    if (laneNow.inLane) {
      const lv = body.linvel();
      const overspeed = Math.hypot(lv.x, lv.z) - PIT_SPEED_LIMIT_MS;
      if (overspeed > -1) {
        gatedDriveInput = {
          ...gatedDriveInput,
          throttle: overspeed > 0 ? 0 : Math.min(gatedDriveInput.throttle, 0.25),
          deploy: false,
          brake: Math.max(gatedDriveInput.brake, overspeed > 0 ? Math.min(0.6, 0.1 + overspeed / 6) : 0),
        };
      }
    }
    // Safety car / VSC: the same limiter as the pit lane, at the period's
    // speed ceiling (plus the catch-up allowance behind the leader), and no
    // ERS deployment.
    const scBase = safetyCarRef?.current ? safetyCarCapMs(safetyCarRef.current) : null;
    if (scBase !== null && raceRef?.current) {
      const race = raceRef.current;
      const gap = roadGapAheadMeters([race.player, ...race.opponents], 0, track.lengthMeters);
      const lv = body.linvel();
      const overspeed = Math.hypot(lv.x, lv.z) - (scBase + catchUpBonusMs(gap));
      if (overspeed > -1) {
        gatedDriveInput = {
          ...gatedDriveInput,
          throttle: overspeed > 0 ? 0 : Math.min(gatedDriveInput.throttle, 0.25),
          deploy: false,
          brake: Math.max(gatedDriveInput.brake, overspeed > 0 ? Math.min(0.8, 0.2 + overspeed / 4) : 0),
        };
      }
    }
    pitBoxMetersRef.current = laneNow.boxAheadMeters;
    const served = stepServe(serveRef.current, {
      inLane: laneNow.inLane,
      inBox: laneNow.boxAheadMeters !== null && Math.abs(laneNow.boxAheadMeters) <= PIT_BOX_HALF_LENGTH,
      speedMs: Math.hypot(body.linvel().x, body.linvel().z),
      dt: world.timestep,
    });
    if (served) {
      // Served in the lane: the up-front time charge is refunded.
      effectiveRaceControlRef.current.state.penaltySeconds -= served.seconds;
      raceElapsedSecondsRef.current -= served.seconds;
      if (hudRef?.current) pushHudEvent(hudRef.current, "good", "PENALTY SERVED", served.kind === "stop-go" ? "STOP-GO" : "DRIVE-THROUGH", 3);
    }
    if (hudRef && laneNow.inLane !== inPitLaneRef.current) {
      inPitLaneRef.current = laneNow.inLane;
      pushHudEvent(hudRef.current, "info", laneNow.inLane ? "PIT LANE · LIMITER 80 KM/H" : "PIT EXIT", undefined, 1.8);
    }

    // Guest input upload reads the gated inputs actually applied (see
    // playerInputRef) - what the car does, not what the keys say.
    if (playerInputRef) {
      playerInputRef.current = {
        throttle: gatedDriveInput.throttle,
        brake: gatedDriveInput.brake,
        steer: gatedDriveInput.steer,
      };
    }

    // Overtake mode uses the same one-second proximity window as the AI.
    // The zone system below adds the track-region gate and exposes the final
    // active state to ERS, so a nearby car alone cannot enable the bonus.
    const race = raceRef?.current;
    let gapAheadMeters = Infinity;
    if (race) {
      for (const o of race.opponents) {
        const gap = unwrapGap(
          race.player.lapCount,
          race.player.progressMeters,
          o.lapCount,
          o.progressMeters,
          track.lengthMeters
        );
        if (gap > 0 && gap < gapAheadMeters) gapAheadMeters = gap;
      }
    }
    const proximityEligible =
      sessionMode === "race" && overtakeModeActive(gapAheadMeters, Math.abs(race?.player.speedMs ?? 0));
    const speedForOps = Math.abs(controller.currentVehicleSpeed());
    overtakeSystem.setRequested(overtakeRequestedRef.current || driveInput.overtake);
    const overtakeState = overtakeSystem.update(
      limitStatus.progressMeters,
      speedForOps,
      proximityEligible ? gapAheadMeters : Infinity
    );
    const overtakeActive = overtakeState.active;
    const strategyState = strategyRef.current.update({
      dt: world.timestep,
      speedMs: speedForOps,
      throttle: gatedDriveInput.throttle,
      brake: gatedDriveInput.brake,
      progressMeters: limitStatus.progressMeters,
      trackLengthMeters: track.lengthMeters,
      lateralMeters: limitStatus.lateralMeters,
      trackHalfWidthMeters: track.width[0] / 2,
      repairSeconds: damageRepairSeconds(damageRef.current),
      inPitBox: pitLane ? laneNow.boxAheadMeters !== null && Math.abs(laneNow.boxAheadMeters) <= PIT_BOX_HALF_LENGTH : undefined,
      lap: race?.player.lapCount ?? 0,
      racing: raceStarted,
      airTemperatureC: weatherStateRef.current.airTemperatureC,
      trackTemperatureC: weatherStateRef.current.trackTemperatureC,
    });
    const weatherState = effectiveWeatherRef.current.snapshot();
    const energyStatus = energySystemRef.current.update(
      {
        brakeAmount: gatedDriveInput.brake,
        deployRequested: gatedDriveInput.deploy,
        overrideActive: overtakeActive,
        lap: race?.player.lapCount ?? 0,
        raceStarted,
      },
      world.timestep
    );
    batteryFractionRef.current = energyStatus.batteryFraction;
    energyStatusRef.current = energyStatus;
    // The release mini-game runs off the strategy's service phase, which is
    // the same signal that drives the lollipop in PitCrew.tsx - so the light
    // the player sees and the window they are timed against cannot disagree.
    //
    // The outcome is a REDUCTION or an ADDITION to race time, nothing else:
    // no force, no pace multiplier, no contact. A clean release cannot make
    // the car faster, so the engine ceiling this codebase is built around is
    // untouched by it.
    const releaseOutcome = stepPitRelease(pitReleaseRef.current, {
      dt: world.timestep,
      inService: strategyState.pitPhase === "service",
      pressed: driveInput.pitReleasePressed,
      enabled: pitReleaseEnabledRef.current,
    });
    if (releaseOutcome && !raceFinishedRef.current) {
      if (releaseOutcome.kind === "credit") {
        raceElapsedSecondsRef.current -= releaseOutcome.seconds;
        if (hudRef) {
          pushHudEvent(
            hudRef.current,
            "good",
            "CLEAN RELEASE",
            `-${releaseOutcome.seconds.toFixed(2)}s`,
            2.6
          );
        }
      } else {
        raceElapsedSecondsRef.current += releaseOutcome.seconds;
        if (hudRef) {
          pushHudEvent(
            hudRef.current,
            "penalty",
            "EARLY RELEASE",
            `+${releaseOutcome.seconds.toFixed(2)}s`,
            2.8
          );
        }
      }
    }

    // Damage persists until a pit crew fixes it - a completed service (the
    // stop counter ticking over) is the repair, not crossing the line.
    if (strategyState.pitStops > strategyStateRef.current.pitStops) {
      setDamage(createDamageState());
    }
    strategyStateRef.current = strategyState;
    overtakeStateRef.current = overtakeState;
    weatherStateRef.current = weatherState;

    // Sync the gearbox's assist mode to the live toggle (useDriveInput
    // owns the G key, Car.tsx owns the gear state) before the drive model
    // and HUD both read it this tick.
    gearboxRef.current.auto = autoGear.current;
    const gearBeforeControls = gearboxRef.current.gear;
    applyCarControls(
      controller,
      gatedDriveInput,
      DEFAULT_ENGINE_FORCE,
      energyStatus.engineForceMultiplier * strategyState.engineMultiplier * strategyState.paceMultiplier * (overtakeState.active ? OVERTAKE_BOOST_MULTIPLIER : 1),
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed(),
      tractionControlEnabled.current,
      {
        state: gearboxRef.current,
        shiftUp: gatedDriveInput.shiftUp,
        shiftDown: gatedDriveInput.shiftDown,
        selectReverse: gatedDriveInput.selectReverse,
      }
    );
    // Every shift, up or down, so the audio can voice the blip as well as the cut.
    if (gearboxRef.current.gear !== gearBeforeControls) shiftSerialRef.current += 1;

    // The strategy system owns compound life now; keyboard tire selection is
    // still a quick practice-mode fitting shortcut, while a race pit request
    // refits through the same system.
    if (tireCompound.current !== strategyState.compound) {
      strategyRef.current.setCompound(tireCompound.current);
    }
    const compoundGripMultiplier = strategyState.compoundGripMultiplier;
    // Wet-track grip for the fitted compound (slicks: the weather's own curve).
    const weatherGrip = weatherGripForCompound(strategyState.compound, weatherState);
    // Tyre pressure (the player's setup slider), resolved against the LIVE
    // carcass temperature so the grip it buys is paid out over the stint
    // rather than granted at the start line. At the neutral pressure this is
    // exactly 1 at every temperature, so a player who never touches the slider
    // drives the validated car. Reuses the strategy system's own temperature
    // so it agrees with the HUD tyre-temperature readout.
    const pressureGrip = tyrePressureGripScale(
      setupPressure,
      computeTireWarmth(strategyState.tireTemperatureC)
    );
    // Per-wheel surfaces (plan section 4 point 7 / section 5 depth feature 6),
    // replacing the old single chassis-center distanceFromEdgeMeters
    // approximation: each wheel is classified separately, so clipping an apex
    // kerb or dropping one wheel into a gravel trap acts on that wheel rather
    // than being averaged across the whole car. Two wheels off is a very
    // different car from four, which is the skill this exists to create.
    const wheelSurfaces = sampleWheelSurfaces(track, wheelGroundPositions(body));
    kerbContactRef.current = wheelSurfaces.kerbContactFraction;
    wheelGripsRef.current = wheelSurfaces.grips;
    applyKerbRideHeights(controller, wheelSurfaces.rideHeights);
    applyLoadSensitiveFriction(
      controller,
      aeroMode.current,
      compoundGripMultiplier * weatherGrip * pressureGrip,
      wheelSurfaces.grips,
      damageGripsRef.current
    );

    // Live telemetry for the engineer overlay (see lib/race/telemetry.ts).
    // Written into a ref the panel reads on its own rAF, never into React
    // state - this runs every physics step and a setState here would
    // re-render the whole HUD at 60Hz. Skipped entirely when the overlay is
    // closed, so a session that never opens it pays nothing.
    if (telemetryRef) {
      // Guard on the REF being provided, not on `.current` being truthy. The
      // ref is created empty and mutated in place (no per-frame allocation),
      // so the first write has to create the object - guarding on `.current`
      // meant nothing ever assigned it, the block never ran, and every
      // readout stayed blank for the whole session.
      const telemetryTarget = (telemetryRef.current ??= emptyTelemetrySample());
      const rotation = body.rotation();
      const yawNow = yawFromQuaternion(rotation.x, rotation.y, rotation.z, rotation.w);
      const linvelNow = body.linvel();
      const angvelNow = body.angvel();
      const speedNow = controller.currentVehicleSpeed();
      const effectiveGrip =
        compoundGripMultiplier * weatherGrip * pressureGrip * damageGripMultiplierRef.current;

      // CAR_WHEELS order is front-left, front-right, rear-left, rear-right,
      // which is exactly WHEEL_ORDER's order.
      const corners = WHEEL_ORDER.map((corner, index) => {
        const loadN = controller.wheelSuspensionForce(index);
        const load = Number.isFinite(loadN) ? (loadN as number) : 0;
        const grip = wheelSurfaces.grips[index] * effectiveGrip;
        return [
          corner,
          {
            loadN: load,
            grip: Number.isFinite(grip) ? Math.max(0, grip) : 0,
            // Rapier collapses the suspension force when a corner is airborne,
            // which is exactly the "not touching" signal the panel wants. A
            // quarter of static is well clear of any load a planted wheel
            // carries at rest, so this cannot flicker.
            inContact: load > STATIC_WHEEL_LOAD_N * 0.25,
            temperatureC: strategyStateRef.current.tireTemperatureC,
          },
        ] as const;
      });
      const wheels = Object.fromEntries(corners) as TelemetrySample["wheels"];
      let totalLoadN = 0;
      for (const corner of WHEEL_ORDER) totalLoadN += wheels[corner].loadN;

      telemetryTarget.wheels = wheels;
      telemetryTarget.totalLoadN = totalLoadN;
      // Lateral g from the centripetal term (speed x yaw rate) rather than by
      // differentiating velocity: the frame-to-frame derivative of a raycast
      // vehicle's velocity is far too noisy for a live readout, and this is
      // smooth, cheap and the right magnitude.
      const yawRateRadS = angvelNow.y;
      telemetryTarget.lateralG = (Math.abs(speedNow * yawRateRadS)) / 9.81;
      telemetryTarget.longitudinalG =
        (driveInput.throttle * driveInput.throttle * DEFAULT_ENGINE_FORCE -
          driveInput.brake * driveInput.brake * DEFAULT_BRAKE_FORCE) /
        (CHASSIS_MASS * 9.81);
      telemetryTarget.yawRateDegS = (yawRateRadS * 180) / Math.PI;
      telemetryTarget.slipAngleDeg = slipAngleDeg(yawNow, linvelNow.x, linvelNow.z);
      telemetryTarget.rpm = rpmForGear(
        gearboxSpeedMs(gearboxRef.current, speedNow),
        gearboxRef.current.gear,
        gearboxRef.current.finalDriveScale
      );
      telemetryTarget.redlineRpm = REDLINE_RPM;
    }

    controller.updateVehicle(world.timestep);

    applyVehicleStabilityTorques(body, DEFAULT_STABILIZE_STRENGTH, world.timestep);
    const downforceN =
      computeDownforceN(controller.currentVehicleSpeed(), aeroMode.current, setupDown) * damageDownforceRef.current;
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    // Slipstream (see towDragScale): tucked in behind a rival, less drag.
    const towPos = body.translation();
    const towVel = body.linvel();
    const towRot = body.rotation();
    const towTraffic = trafficRef?.current;
    const towDrag = towTraffic
      ? towDragScale(
          {
            x: towPos.x,
            z: towPos.z,
            yawRad: yawFromQuaternion(towRot.x, towRot.y, towRot.z, towRot.w),
            speedMs: Math.hypot(towVel.x, towVel.z),
          },
          Object.entries(towTraffic).flatMap(([key, at]) => (key === trafficKey ? [] : [at]))
        )
      : 1;
    applyDragImpulse(
      body,
      aeroMode.current,
      world.timestep,
      towDrag * weatherState.dragMultiplier * setupDrag
    );
    // Grass/gravel drag (plan section 4 point 7), on top of the aero drag
    // above - a wide moment costs time, and a gravel trap takes the car off
    // the driver's hands entirely rather than merely slowing it.
    applySurfaceDragImpulse(body, wheelSurfaces.meanDragCoefficient, world.timestep);

    const replaySample = snapshotOf(body);
    rewindBufferRef.current.push({
      ...replaySample,
      damage: damageGripMultiplierRef.current,
      damageParts: copyDamageState(damageRef.current, createDamageState()),
    });
    replayRef.current.record({
      ...replaySample,
      telemetry: {
        elapsedSeconds: raceElapsedSecondsRef.current,
        speedMs: speedForOps,
        throttle: gatedDriveInput.throttle,
        brake: gatedDriveInput.brake,
        steer: gatedDriveInput.steer,
        gear: gearboxRef.current.gear,
        rpm: rpmForGear(
          gearboxSpeedMs(gearboxRef.current, speedForOps),
          gearboxRef.current.gear,
          gearboxRef.current.finalDriveScale
        ),
        batteryFraction: energyStatus.batteryFraction,
        tireGrip: strategyState.compoundGripMultiplier * weatherGrip,
        overtakeActive: overtakeState.active,
        weather: weatherLabel(weatherState.preset),
      } satisfies TelemetryFrame,
    });
    if (trafficRef && trafficKey !== undefined) {
      const tp = body.translation();
      trafficRef.current[trafficKey] = { x: tp.x, z: tp.z };
    }
    if (carPosesRef) {
      const rot = body.rotation();
      const lv = body.linvel();
      const pp = body.translation();
      carPosesRef.current[(playerGridSpot ?? 1) - 1] = {
        position: [pp.x, pp.y, pp.z],
        rotation: [rot.x, rot.y, rot.z, rot.w],
        linvel: [lv.x, lv.y, lv.z],
      };
    }
  });

  /**
   * The chequered flag and the classification (see
   * lib/race/classification.ts): the flag falls when the LEADER completes the
   * distance, whoever that is, and every car is classified at its next
   * crossing. The results go up a few seconds after the player takes the
   * flag - a short cool-down, the way a broadcast holds on the finish.
   */
  function updateFlags(dt: number, lapState: LapTimerState) {
    const hud = hudRef?.current;
    const race = raceRef?.current;
    if (!hud || !race) return;
    const status = stepFlags(
      flagStateRef.current,
      rivals,
      race.player,
      race.opponents,
      track.lengthMeters,
      dt,
      raceClockRef.current
    );
    const text = flagChipText(status);
    const lap = track.lengthMeters;
    hud.yellowStation = status.yellow ? (((race.player.progressMeters + status.yellow.aheadMeters) % lap) + lap) % lap : -1;
    if (text !== hud.flagText) {
      const was = hud.flagText;
      hud.flagText = text;
      if (status.yellow && !was.startsWith("YELLOW")) {
        pushHudEvent(hud, "flag", "YELLOW FLAG", `${status.yellow.code} STOPPED AHEAD`, 2.6);
      } else if (status.blue && !was.startsWith("BLUE")) {
        pushHudEvent(hud, "flag", "BLUE FLAG", `LET ${status.blue.code} PASS`, 2.6);
      } else if (!text && was.startsWith("YELLOW")) {
        pushHudEvent(hud, "flag", "TRACK CLEAR", undefined, 1.6);
      }
    }
    updateOvertakingPenalties(status, race, lapState);
  }

  /**
   * Overtaking under a yellow, VSC or safety car (lib/race/overtakePenalties.ts).
   *
   * READ-ONLY over the race progress: it watches for the player completing a
   * pass while a restriction is in force and charges a warning, then a time
   * penalty through race control. It deliberately does not steer, slow or
   * otherwise touch any car - the AI in particular is left exactly as it was,
   * because a feature that moved the AI would invalidate every stability gate
   * in the suite. The penalty is a time charge on the player's race time,
   * which is why it cannot affect the 1750 N engine ceiling either.
   *
   * The restriction is the most severe thing in force, with a LOCAL yellow
   * beating a VSC: `status.yellow` is only set for an incident on the
   * player's own stretch of track (see flags.ts), which is the "local yellow"
   * the rule is about - a yellow elsewhere on the circuit does not restrict
   * the player and must not be penalized.
   */
  function updateOvertakingPenalties(
    status: ReturnType<typeof stepFlags>,
    race: { player: RaceProgress; opponents: RaceProgress[] },
    lap: LapTimerState
  ) {
    const hud = hudRef?.current;
    if (!hud) return;
    const safetyCar = safetyCarRef?.current;
    const scKind = safetyCar && safetyCar.phase !== "none" ? safetyCar.kind : null;
    const restriction: OvertakeRestriction = status.yellow
      ? "yellow"
      : scKind === "sc"
        ? "sc"
        : scKind === "vsc"
          ? "vsc"
          : "none";
    const event = stepOvertakePenalties(overtakePenaltyRef.current, {
      player: race.player,
      opponents: race.opponents,
      codes: rivals.map((rival) => rival.code),
      trackLengthMeters: track.lengthMeters,
      restriction,
      racing: !raceFinishedRef.current,
      raceSeconds: raceElapsedSecondsRef.current,
    });
    const chip = overtakePenaltyText(overtakePenaltyRef.current);
    if (chip !== hud.overtakePenaltyText) hud.overtakePenaltyText = chip;
    if (!event) return;

    const message = overtakePenaltyMessage(event);
    if (event.type === "warning") {
      // A warning is news, not a charge: nothing goes to race control and the
      // race clock is untouched, so the only cost is the warning itself.
      pushHudEvent(hud, "warn", "RACE CONTROL WARNING", message, 3.2);
      queueEngineerLine(hud, overtakeEngineerLine(event));
      return;
    }
    const penaltySeconds = event.penaltySeconds;
    effectiveRaceControlRef.current.reportIncident("overtaking", raceElapsedSecondsRef.current, {
      penaltySeconds,
      severity: "time",
      message,
    });
    if (!raceFinishedRef.current) {
      raceElapsedSecondsRef.current += penaltySeconds;
      if (!lapInvalidRef.current) {
        lapInvalidAtSecondsRef.current = lap.currentLapSeconds;
      }
      lapInvalidRef.current = true;
      if (hud) pushHudEvent(hud, "penalty", overtakePenaltyLabel(event.penaltyCount), message, 3.6);
    }
    queueEngineerLine(hud, overtakeEngineerLine(event));
  }

  function updateRaceFinish(playerLaps: number, dt: number) {
    const hud = hudRef?.current;
    const race = raceRef?.current;
    if (!hud || !race) return;
    raceClockRef.current += dt;
    const opponentLaps = rivals.map((_, k) => Math.max(0, race.opponents[k]?.lapCount ?? 0));
    const tracker = finishTrackerRef.current;
    const update = updateFinishTracker(tracker, [playerLaps, ...opponentLaps], raceLaps, raceClockRef.current);
    if (update.finalLapNow) pushHudEvent(hud, "flag", "FINAL LAP", undefined, 2.4);
    if (update.chequeredNow) {
      hud.chequered = true;
      const winner = update.finishedNow[0];
      pushHudEvent(
        hud,
        "flag",
        "CHEQUERED FLAG",
        winner === 0 ? "YOU WIN" : winner !== undefined ? `${rivals[winner - 1]?.code ?? ""} WINS` : undefined,
        3.5
      );
    }
    if (update.finishedNow.includes(0) && !raceFinishedRef.current) {
      raceFinishedRef.current = true;
      resultsAtClockRef.current = raceClockRef.current + RESULTS_DELAY_SECONDS;
    }
    if (resultsAtClockRef.current === null || raceClockRef.current < resultsAtClockRef.current) return;

    const control = effectiveRaceControlRef.current.snapshot();
    const live = computeRacePositions([race.player, ...race.opponents], track.lengthMeters);
    const rows = classifyRace(
      [
        {
          code: playerCode,
          name: playerName,
          teamId: playerTeamId ?? null,
          color: bodyColor,
          isPlayer: true,
          laps: playerLaps,
          livePosition: live[0],
          bestLapSeconds: bestLapRef.current,
          penaltySeconds: control.penaltySeconds,
        },
        ...rivals.map((rival, k) => ({
          code: rival.code,
          name: rival.name ?? null,
          teamId: rival.teamId ?? null,
          color: rival.color,
          isPlayer: false,
          laps: opponentLaps[k],
          livePosition: live[k + 1] ?? k + 2,
          bestLapSeconds: race.opponents[k]?.bestLapSeconds ?? null,
          penaltySeconds: 0,
        })),
      ],
      tracker,
      sprint
    );
    const classified = rows.find((row) => row.isPlayer)?.position ?? live[0];
    // Net rooms: the host's broadcast order is the result (see
    // netResultRef) - every guest shows the same position, and nobody scores
    // a championship round from an exhibition. Slot-keyed, so shared driver
    // codes can't collide.
    const netPositions = netActive ? netResultRef?.current?.positions ?? null : null;
    const shown = netPositions?.[String(netSlot)] ?? classified;
    const scoredRound = champRound !== null && !netActive ? champRound : null;
    if (scoredRound !== null) {
      // Fire-and-forget: the standings panel reads it back on the way home.
      const resultRows = rows.map((row) => ({
        code: row.code,
        name: row.name,
        teamId: row.teamId,
        position: row.position,
        points: row.points,
        isPlayer: row.isPlayer,
      }));
      (sprint
        ? recordChampionshipSprint(scoredRound, classified, resultRows)
        : recordChampionshipResult(scoredRound, classified, resultRows)
      ).catch(() => {});
    }
    hud.result = {
      kind: "race",
      position: shown,
      laps: raceLaps,
      rows,
      penaltySeconds: control.penaltySeconds,
      disqualified: control.disqualified,
      champRound: scoredRound,
      points: rows.find((row) => row.isPlayer)?.points ?? pointsForPosition(classified),
      sprint,
    };
  }

  function renderSectors() {
    const hud = hudRef?.current;
    if (!hud) return;
    hud.sectors = sectorResultsRef.current.map((sector) =>
      sector ? { seconds: sector.sectorSeconds, color: sector.color } : null
    );
  }

  /** Attaches the timeline's capture-phase key listener. See timelineKeysRef. */
  function attachTimelineKeys() {
    if (timelineKeysRef.current || typeof window === "undefined") return;
    const state = { scrubBack: false, scrubForward: false, confirm: false, cancel: false };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "ArrowLeft" || event.code === "BracketLeft") state.scrubBack = true;
      else if (event.code === "ArrowRight" || event.code === "BracketRight") state.scrubForward = true;
      else if (event.code === "Enter" || event.code === "NumpadEnter") state.confirm = true;
      else if (event.code === "Escape") state.cancel = true;
      else return;
      // Swallow it so the pause menu and the drive bindings behind the
      // timeline do not also act on the same keypress. stopPropagation, not
      // preventDefault: we still want the browser's own key repeat to fire.
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    timelineKeysRef.current = state;
    timelineKeysDetachRef.current = () => window.removeEventListener("keydown", onKeyDown, true);
  }

  function detachTimelineKeys() {
    timelineKeysDetachRef.current?.();
    timelineKeysDetachRef.current = null;
    timelineKeysRef.current = null;
  }

  /**
   * The flashback timeline, driven from useFrame rather than the physics step.
   *
   * That placement is the whole reason this works: opening the timeline pauses
   * the simulation (page.tsx gates `<Physics paused>` on it), and
   * useBeforePhysicsStep does NOT run while physics is paused - so a scrub
   * implemented there would freeze the instant it opened. useFrame keeps
   * running, which is what lets the player scrub a paused race.
   *
   * The car is moved kinematically while scrubbing so the player can SEE the
   * pose they are choosing, exactly as the existing hold-R rewind does
   * (applySnapshot with zeroed velocity). On confirm the same rewindBuffer
   * path runs as before, so the physics result of a flashback is unchanged by
   * this UI existing; on cancel the present pose is put back.
   */
  function stepFlashbackTimeline(): void {
    const timeline = flashbackTimelineRef.current;
    const hud = hudRef?.current;
    const controller = controllerRef.current;
    const body = chassisRef.current;
    const open = isFlashbackTimelineOpen(timeline);
    if (!controller || !body) return;

    // Opening: a TAP of R opens the timeline, a HOLD keeps the existing
    // hold-to-rewind. A player mid-spin gets the quick rewind they already
    // know; a player who wants to choose the moment gets the scrub.
    //
    // The two are told apart by how far the hold actually rewound, measured
    // with the same MIN_FLASHBACK_SECONDS threshold the allowance is spent
    // against - so "did this press count as a flashback" has exactly one
    // definition in this file, and a tap can never spend one. It is NOT
    // `wasRewindingRef`: that is true for any hold longer than a single frame,
    // so testing it would mean a tap could never open the timeline at all.
    if (!open && input.current.rewindReleased && rewindCursorRef.current < MIN_FLASHBACK_SECONDS) {
      // Acknowledge the release immediately, whether or not there was enough
      // history to open: a release that is not cleared would reopen the
      // timeline on every subsequent frame.
      clearRewindReleased();
      const capacity = rewindBufferRef.current.oldestAvailableSeconds();
      if (capacity >= MIN_FLASHBACK_SECONDS) {
        openFlashbackTimeline(timeline, capacity);
        savedPoseRef.current = snapshotOf(body);
        attachTimelineKeys();
        onFlashbackTimelineOpenChange?.(true);
        if (hud) pushHudEvent(hud, "info", "FLASHBACK TIMELINE", "SCRUB AND PRESS ENTER", 2.4);
        return;
      }
    }

    if (!open) {
      // A release with no history behind it still has to be acknowledged, or
      // it would sit latched and fire the moment a buffer filled up.
      if (input.current.rewindReleased) clearRewindReleased();
      if (hud) hud.flashbackTimelineOpen = false;
      return;
    }
    if (hud) hud.flashbackTimelineOpen = true;

    // The trace is frozen while the timeline is open (see the record call in
    // the physics step), so the strip is stable under the cursor. Keys come
    // from the capture-phase listener (see timelineKeysRef).
    const keys = timelineKeysRef.current;
    const confirm = keys?.confirm ?? false;
    const cancel = keys?.cancel ?? false;
    if (keys) {
      // Consumed every frame, so a held key repeats on its own at the frame
      // rate rather than relying on the browser's key-repeat.
      if (keys.scrubBack) scrubFlashbackTimeline(timeline, timeline.secondsAgo + SCRUB_STEP_SECONDS);
      if (keys.scrubForward) scrubFlashbackTimeline(timeline, timeline.secondsAgo - SCRUB_STEP_SECONDS);
      keys.scrubBack = false;
      keys.scrubForward = false;
      keys.confirm = false;
      keys.cancel = false;
    }

    // Preview the scrubbed pose. Kinematic: velocity is zeroed so the car sits
    // at each past pose instead of driving away from under the player.
    const sample = rewindBufferRef.current.sampleAt(timeline.secondsAgo);
    if (sample) applySnapshot(body, sample, true);

    if (confirm) {
      const exit: FlashbackTimelineExit = confirmFlashbackTimeline(timeline);
      detachTimelineKeys();
      onFlashbackTimelineOpenChange?.(false);
      if (hud) hud.flashbackTimelineOpen = false;
      if (exit.kind === "confirmed" && exit.secondsAgo >= MIN_FLASHBACK_SECONDS) {
        // Hand the real rewind to the existing machinery: it discards the
        // scrubbed-away future, rolls the lap and sector clocks back and
        // spends a flashback from lib/race/flashbacks.ts.
        rewindCursorRef.current = exit.secondsAgo;
        wasRewindingRef.current = true;
      } else {
        // Cancelled, or confirmed with the head at zero: put the car back
        // exactly where it was and resume.
        const saved = savedPoseRef.current;
        if (saved) applySnapshot(body, saved, false);
        savedPoseRef.current = null;
      }
      return;
    }
    if (cancel) {
      cancelFlashbackTimeline(timeline);
      detachTimelineKeys();
      onFlashbackTimelineOpenChange?.(false);
      if (hud) hud.flashbackTimelineOpen = false;
      const saved = savedPoseRef.current;
      if (saved) applySnapshot(body, saved, false);
      savedPoseRef.current = null;
      return;
    }
  }

  useFrame((_, dt) => {
    stepFlashbackTimeline();
    // Hide the chassis mesh in cockpit mode - otherwise the camera (see
    // ChaseCamera in Scene.tsx) sits inside a solid box and renders its
    // inside faces. Cheaper and more robust than offsetting the camera
    // just ahead of the chassis, which would still clip through on a hard
    // pitch/roll. Runs before the controller/body guard below so a
    // transient null (a remount, a track change) while in cockpit mode
    // can't leave the car permanently invisible with nothing left to
    // restore it.
    //
    // The helmet view deliberately KEEPS the body visible: the sculpted
    // shell is a closed surface, so from the driver's eye the near-side
    // faces cull away and the nose, halo, cockpit rim and far bodywork read
    // as the car's own structure around the wheel instead of a floating
    // wheel in a void.
    const interiorCamera = cameraMode.current === "cockpit";
    if (visualRef?.current) {
      visualRef.current.visible = !interiorCamera;
    }

    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
    if (steeringWheelRef.current) {
      steeringWheelRef.current.visible = cameraMode.current === "helmet";
      steeringWheelRef.current.rotation.z = steeringWheelAngle(input.current.steer);
    }
    if (helmetCockpitRef.current) {
      helmetCockpitRef.current.visible = cameraMode.current === "helmet";
    }
    CAR_WHEELS.forEach((wheel, i) => {
      const steerGroup = steerRefs.current[i];
      const spinGroup = spinRefs.current[i];
      if (steerGroup && wheel.isSteering) {
        steerGroup.rotation.y = controller.wheelSteering(i) ?? 0;
      }
      if (spinGroup) {
        spinGroup.rotation.x = controller.wheelRotation(i) ?? 0;
      }
    });
    // Active-aero flap (plan section 5): the rear-wing top element rotates
    // open in low-drag mode and shut otherwise, rate-limited like a real
    // actuator rather than snapping.
    if (flapRef.current) {
      const target = aeroMode.current === "low-drag" ? FLAP_OPEN_RAD : 0;
      flapRef.current.rotation.x = stepFlapAngle(flapRef.current.rotation.x, target, dt);
    }
    // HUD data (see lib/race/hud.ts): plain values only - the widgets in
    // app/race/hud/ do all formatting and DOM work on their own frames.
    const hud = hudRef?.current;
    if (hud) {
      const strategy = strategyStateRef.current;
      const energy = energyStatusRef.current;
      // The final drive is passed here for the same reason it is passed to
      // applyCarControls: the rev counter has to read the gearing the engine
      // is actually turning, or the slider would be invisible on the HUD and
      // in the telemetry overlay while still changing the car.
      const rpm = rpmForGear(
        gearboxSpeedMs(gearboxRef.current, controller.currentVehicleSpeed()),
        gearboxRef.current.gear,
        gearboxRef.current.finalDriveScale
      );
      hud.speedKmh = Math.abs(controller.currentVehicleSpeed()) * 3.6;
      hud.gear = isReverse(gearboxRef.current.gear) ? "R" : `${gearboxRef.current.gear}`;
      hud.rpm01 = Math.min(1, Math.max(0, (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)));
      // The shift light teaches the auto-assist's optimal band (the skill
      // manual drivers learn by feel).
      hud.rpmZone = rpm >= SHIFT_UP_RPM ? "shift" : engineTorqueMultiplier(rpm) >= 0.99 ? "band" : "low";
      hud.throttle = Math.min(1, Math.max(0, input.current.throttle));
      hud.brake = Math.min(1, Math.max(0, input.current.brake));
      hud.steer = Math.min(1, Math.max(-1, input.current.steer));
      hud.ers01 = batteryFractionRef.current;
      hud.ersMode = energy.mode;
      hud.deployBudget01 = energy.deploymentBudgetFraction;
      hud.lowDrag = aeroMode.current === "low-drag";
      hud.overtakeActive = overtakeStateRef.current.active;
      hud.compound = strategy.compound;
      // Includes the pressure term so the MFD tyre page shows the grip the
      // player is ACTUALLY getting, not the compound-and-weather part of it.
      // The tyre-temperature readout beside it is the same number the
      // pressure's warm-up half is driven from, so the two are consistent:
      // watch the temperature climb and the grip follow it up.
      hud.tyreGrip =
        strategy.compoundGripMultiplier *
        weatherGripForCompound(strategy.compound, weatherStateRef.current) *
        tyrePressureGripScale(setupPressure, computeTireWarmth(strategy.tireTemperatureC));
      hud.tyreTempC = strategy.tireTemperatureC;
      stepWheelTemps(wheelTempsRef.current, strategy.tireTemperatureC, {
        latG: (Math.abs(controller.currentVehicleSpeed()) * body.angvel().y) / 9.81,
        brake01: input.current.brake,
        throttle01: input.current.throttle,
        dt,
      });
      for (let i = 0; i < 4; i++) hud.wheelTempC[i] = wheelTempsRef.current[i];
      hud.tyreWear01 = tyreWear01(strategy.compound, strategy.tireAgeMeters);
      hud.fuelKg = strategy.fuelKg;
      hud.fuelWarning = strategy.fuelWarning;
      hud.strategyMode = strategy.mode;
      hud.pitPhase = strategy.pitPhase;
      hud.pitStops = strategy.pitStops;
      hud.inPitLane = inPitLaneRef.current;
      hud.hasPitLane = getPitLane(track) !== null;
      hud.pitProgress = strategy.pitProgress;
      // The release hint is computed once per frame here, not in the widget:
      // the widget only reads a string, so this stays on the same pattern as
      // every other HUD value (plain values, written by gameplay code).
      hud.pitReleasePhase = pitReleaseRef.current.phase;
      hud.pitReleaseText = pitReleaseEnabledRef.current
        ? pitReleaseHint(
            pitReleaseRef.current,
            // Resolved per frame rather than cached at mount, so a rebind of
            // the release key is reflected on the very next frame.
            formatKeyCode(getBindings().pitRelease[0]),
            strategy.pitProgress
          )
        : "";
      hud.pitBoxMeters = pitBoxMetersRef.current;
      hud.servePrompt = servePrompt(serveRef.current, {
        inLane: inPitLaneRef.current,
        inBox: pitBoxMetersRef.current !== null && Math.abs(pitBoxMetersRef.current) <= PIT_BOX_HALF_LENGTH,
      });
      hud.damage = damageGripMultiplierRef.current;
      hud.damageParts.frontWing = damageRef.current.frontWing;
      hud.damageParts.rearWing = damageRef.current.rearWing;
      hud.damageParts.floor = damageRef.current.floor;
      hud.damageParts.puncture = damageRef.current.puncture;
      hud.damageRepairSeconds = damageRepairSeconds(damageRef.current);
      hud.flashbacksLeft = flashbacksLeftRef.current;
      // Published BY REFERENCE so the strip widget can read the live trace on
      // its own 20Hz tick without this copying 150 samples per frame.
      hud.flashbackTrace = flashbackTraceRef.current;
      // The timeline takes over this readout while it is open; otherwise these
      // are the hold-R scrub bar's numbers.
      const timeline = flashbackTimelineRef.current;
      hud.flashbackSeconds = isFlashbackTimelineOpen(timeline)
        ? timeline.secondsAgo
        : wasRewindingRef.current
          ? rewindCursorRef.current
          : 0;
      hud.flashbackCapacity = isFlashbackTimelineOpen(timeline)
        ? timeline.capacity
        : wasRewindingRef.current
          ? rewindBufferRef.current.oldestAvailableSeconds()
          : 0;
      hud.tc = tractionControlEnabled.current;
      hud.abs = absEnabled.current;
      hud.autoGear = autoGear.current;
      hud.pad = gamepadConnected.current;
      hud.racingLine = racingLineVisible.current;
      hud.weather = weatherStateRef.current.preset;
      hud.trackTempC = weatherStateRef.current.trackTemperatureC;
    }
    // Race audio snapshot (see lib/audio/raceAudio.ts): runs before the
    // rewind/countdown early returns below so the engine idles on the grid
    // and revs with the throttle even before the lights go out.
    if (audioRef) {
      const p = body.translation();
      const r = body.rotation();
      const yaw = yawFromQuaternion(r.x, r.y, r.z, r.w);
      const lv = body.linvel();
      // Same forward/right convention as the minimap (see
      // lib/tracks/minimap.ts): forward is (-sin yaw, -cos yaw).
      const forwardMs = lv.x * -Math.sin(yaw) + lv.z * -Math.cos(yaw);
      const lateralMs = lv.x * Math.cos(yaw) - lv.z * Math.sin(yaw);
      const audioRpm = rpmForGear(
        gearboxSpeedMs(gearboxRef.current, controller.currentVehicleSpeed()),
        gearboxRef.current.gear,
        gearboxRef.current.finalDriveScale
      );
      const skid01 = skidAmount01(lateralMs, forwardMs);
      audioRef.current.player = {
        rpm01: rpmTo01(audioRpm),
        limiter01: limiterAmount(audioRpm),
        throttle01: Math.min(1, Math.max(0, input.current.throttle)),
        skid01,
        x: p.x,
        y: p.y,
        z: p.z,
        yawRad: yaw,
        vx: lv.x,
        vz: lv.z,
        gear: gearboxRef.current.gear,
        kerb01: kerbContactRef.current,
        shiftSerial: shiftSerialRef.current,
        pitLimiter: inPitLaneRef.current,
      };
      // Rubber on the road (see TrackFx.tsx): while the rear tyres slide or
      // lock, lay a strip along the path they travelled since the last one.
      if (fxRef) {
        const speed = Math.hypot(lv.x, lv.z);
        const locking = input.current.brake > 0.95 && !absEnabled.current && speed > 12;
        if ((skid01 > 0.3 || locking) && speed > 4) {
          skidTravelRef.current += speed * dt;
          if (skidTravelRef.current >= 0.5) {
            const len = skidTravelRef.current;
            skidTravelRef.current = 0;
            const heading = Math.atan2(-lv.x, -lv.z);
            for (const w of REAR_WHEELS) {
              // Tarmac only: rubber does not show on grass or gravel.
              if ((wheelGripsRef.current[w] ?? 1) < 0.9 || !controller.wheelIsInContact(w)) continue;
              const c = controller.wheelContactPoint(w);
              if (!c) continue;
              // Centred on the stretch just driven, not on where the tyre is now.
              const back = len / 2 / speed;
              fxRef.current.skids.push(c.x - lv.x * back, c.y, c.z - lv.z * back, heading, len);
            }
          }
        } else {
          skidTravelRef.current = 0;
        }
      }
    }

    if (isRewindingRef.current) return;
    // Grid start (Scene.tsx): the car is stationary during the countdown
    // (throttle is locked in useBeforePhysicsStep above), but lapTimerRef
    // accumulates currentLapSeconds every frame regardless of whether the
    // car moves - without this guard, every session's first lap started
    // ~3.75s in the hole from mount alone, corrupting it as a potential
    // personal best/delta-timer reference the instant the countdown
    // shipped. Nothing below this point needs to run while waiting: no
    // progress is being made yet.
    if (!(raceStartRef?.current ?? true)) return;

    const t = body.translation();
    const bodyRot = body.rotation();
    const lap = lapTimerRef.current.update({ x: t.x, z: t.z }, dt);

    // Race-control track-limits sequence: a first all-four-wheels-off
    // moment is a warning, a sustained/repeated offense raises the
    // black-and-white flag, and only the next stage applies the five-second
    // penalty. Evaluate this before lap completion so a violation on the
    // finish-line frame is attributed to the lap that is actually ending.
    // A wheel still on the asphalt keeps the car legal, same as the real
    // all-four-wheels rule.
    const wheelWorldPositions = wheelGroundPositions(body);
    const allFourWheelsOff = allWheelsOffTrack(track, wheelWorldPositions, CAR_WHEELS[0].radius);
    const limitUpdate = updateTrackLimitSequence(
      trackLimitSequenceRef.current,
      allFourWheelsOff
    );
    if (allFourWheelsOff && !lapInvalidRef.current) {
      lapInvalidAtSecondsRef.current = lap.currentLapSeconds;
      lapInvalidRef.current = true;
      if (sessionMode !== "race" && hudRef?.current) {
        pushHudEvent(hudRef.current, "warn", "LAP INVALIDATED", "TRACK LIMITS");
      }
    }
    if (limitUpdate.penaltyJustApplied) {
      if (!lapInvalidRef.current) lapInvalidAtSecondsRef.current = lap.currentLapSeconds;
      lapInvalidRef.current = true;
      // The ladder in trackLimitSequence escalates repeat penalties
      // (5s -> 10s -> drive-through -> stop-go); charge whatever the steward
      // decided, not a flat five seconds.
      const penaltySeconds = trackLimitSequenceRef.current.lastPenaltySeconds;
      const penaltyLabel = trackLimitPenaltyLabel(trackLimitSequenceRef.current.penaltyCount);
      const severity = penaltySeconds > 10 ? "stop-go" : penaltySeconds > 5 ? "drive-through" : "time";
      effectiveRaceControlRef.current.reportIncident("track-limits", raceElapsedSecondsRef.current, {
        penaltySeconds,
        severity,
      });
      // Where there is a pit lane the penalty can be served in it (refunding
      // the charge above); street circuits keep the flat time cost.
      if (severity !== "time" && getPitLane(track)) queuePenalty(serveRef.current, severity, penaltySeconds);
      if (!raceFinishedRef.current) {
        raceElapsedSecondsRef.current += penaltySeconds;
        if (hudRef?.current) pushHudEvent(hudRef.current, "penalty", penaltyLabel, "TRACK LIMITS", 3.2);
      }
    }

    // Ranked progress comes from the continuity tracker, not the raw
    // scan: at the start/finish seam the scan flickers between ~0 and
    // ~trackLength for a car sitting on the line, slingshotting it
    // between P1 and P20. Edge/lateral/surfaces below keep the scan.
    const tracked = trackProgress(track, t.x, t.z, progressTrackerRef.current, t.y);

    const programmes = programmeRef.current;
    if (programmes) {
      const finished = stepGates(programmes, gatesRef.current, t.x, t.z);
      if (finished) completeProgramme(finished);
      // Rebuild the readout only when something changed.
      const hits = programmes.gateHits.filter(Boolean).length;
      if (hits !== programmeHitsRef.current && hudRef?.current) {
        programmeHitsRef.current = hits;
        hudRef.current.programmeText = programmeSummary(programmes);
      }
    }

    if (!raceFinishedRef.current) {
      raceElapsedSecondsRef.current += dt;
    }
    if (raceRef?.current) {
      const yawNow = yawFromQuaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
      raceRef.current.player = {
        lapCount: standingsLapCount(lap, tracked.progressMeters, track.lengthMeters),
        progressMeters: tracked.progressMeters,
        speedMs: computeSignedForwardSpeed(body.linvel(), yawNow),
        lastLapSeconds: lap.lastLapSeconds,
        bestLapSeconds: bestLapRef.current,
        trackLimitStage: trackLimitSequenceRef.current.stage,
        trackLimitWarningNumber:
          trackLimitSequenceRef.current.stage === "warning"
            ? trackLimitSequenceRef.current.offenses + 1
            : null,
      };
      const progresses = [raceRef.current.player, ...raceRef.current.opponents];
      const positions = computeRacePositions(progresses, track.lengthMeters);
      if (hudRef?.current && !raceFinishedRef.current) {
        hudRef.current.position = positions[0];
        hudRef.current.fieldSize = positions.length;
      }
      // F1 timing tower (see buildTowerEntries/renderTowerHtml): rebuilt
      // at a real ~10Hz, independent of display refresh rate.
      towerClockRef.current += dt;
      if (hudRef?.current && towerClockRef.current >= 0.1) {
        towerClockRef.current %= 0.1;
        const entries = buildTowerEntries(
          {
            code: playerCode,
            name: playerName,
            number: playerNumber,
            teamId: playerTeamId,
            color: bodyColor,
            progress: raceRef.current.player,
          },
          towerOpponents(rivals, raceRef.current.opponents),
          track.lengthMeters
        );
        hudRef.current.tower = entries;
        hudRef.current.towerVersion += 1;
      }
    }

    const continuousLap = !lapHadDiscontinuityRef.current;
    const eligible =
      sessionMode === "qualifying"
        ? isQualifyingLapValid(lapInvalidRef.current, qualifyingDiscontinuityRef.current)
        : !lapInvalidRef.current && continuousLap;

    // Playable Qualifying (plan section 7): best valid lap per car,
    // informing the overlay below in race mode and the grid in qualifying
    // sessions. A corrected qualifying rewind is a valid session result,
    // while continuousLap still keeps that non-monotonic lap out of the
    // personal-best/ghost/delta reference. Checked every frame (not just
    // inside the crossedFinishLine block below) since the cars' laps usually
    // finish on different frames.
    if (sessionMode !== "qualifying" && hudRef?.current && !qualifyingDisplayedRef.current) {
      const pole = qualifyingRef?.current ? polePosition(qualifyingRef.current) : null;
      if (pole !== null && qualifyingRef?.current) {
        qualifyingDisplayedRef.current = true;
        const playerTime = qualifyingRef.current.player as number;
        // Fastest rival lap and its code for the overlay.
        let rivalTime: number | null = null;
        let rivalCode = "RIVAL";
        qualifyingRef.current.opponents.forEach((time, k) => {
          if (time !== null && (rivalTime === null || time < rivalTime)) {
            rivalTime = time;
            rivalCode = rivals[k]?.code ?? "RIVAL";
          }
        });
        const onPole =
          pole === "player" ? "YOU" : (rivals[pole]?.code ?? rivalCode);
        pushHudEvent(
          hudRef.current,
          "info",
          `${onPole} ON POLE`,
          `YOU ${formatLapTime(playerTime)} · ${rivalCode} ${formatLapTime(rivalTime)}`,
          4
        );
      }
    }

    if (lap.crossedFinishLine && lap.lastLapSeconds !== null && programmes) {
      recordProgrammeLap(programmes, lap.lastLapSeconds, eligible).forEach(completeProgramme);
    }

    if (lap.crossedFinishLine && lap.lastLapSeconds !== null) {
      // The session's own best BEFORE this lap, which is what decides whether
      // the lap is an improvement. Read from the qualifying session because
      // that is the single place the best already lives - a second best-lap
      // variable here would be a third copy of the same number.
      const previousBestMs =
        qualiSessionRef.current.best.player === null
          ? null
          : qualiSessionRef.current.best.player * 1000;

      if (qualifyingRef?.current && eligible) {
        const prev = qualifyingRef.current.player;
        if (prev === null || lap.lastLapSeconds < prev) {
          qualifyingRef.current.player = lap.lastLapSeconds;
        }
      }
      if (sessionMode === "qualifying" && !qualiFinishedRef.current) {
        qualiSessionRef.current = recordQualiLap(
          qualiSessionRef.current,
          "player",
          eligible ? lap.lastLapSeconds : null
        );
        // Time attack: a qualifying session with no clock, where every lap that
        // beats the driver's own best is saved to the public board. Fired and
        // forgotten from the frame loop on purpose - a slow or unreachable
        // board must not be able to stall the simulation, and there is no
        // retry: a lost save costs a row, not the session.
        if (timeAttack && eligible) {
          const lapMs = lap.lastLapSeconds * 1000;
          if (isSaveableTimeAttackLap(previousBestMs, lapMs)) {
            saveTimeAttackLap(lapMs, track.id);
          }
        }
      }
      if (sessionMode === "practice" && !raceFinishedRef.current && lap.lapCount >= raceLaps && hudRef?.current) {
        // Solo session: driving on after the count is fine, but the banner
        // fires once with the session's best and a way back. Runs before
        // the wasNewBest bookkeeping below, so fold this lap in by hand.
        raceFinishedRef.current = true;
        const candidates = [bestLapRef.current, eligible ? lap.lastLapSeconds : null].filter(
          (v): v is number => v !== null
        );
        const sessionBest = candidates.length > 0 ? Math.min(...candidates) : null;
        hudRef.current.result = { kind: "practice", laps: raceLaps, bestLapSeconds: sessionBest };
      }
      const wasNewBest =
        eligible &&
        continuousLap &&
        (bestLapRef.current === null || lap.lastLapSeconds < bestLapRef.current);
      if (wasNewBest) {
        bestLapRef.current = lap.lastLapSeconds;
        if (hudRef?.current) {
          pushHudEvent(hudRef.current, "good", "PERSONAL BEST", formatLapTime(lap.lastLapSeconds), 3);
        }
      }
      deltaTrackerRef.current.endLap(lap.lastLapSeconds, track.lengthMeters, wasNewBest);
      // Same eligibility as the delta timer's reference (see its own
      // endLap comment) - the ghost should be the same lap the delta is
      // measured against, not a separately-chosen one.
      ghostRecorderRef.current.endLap(wasNewBest);
      if (wasNewBest) {
        // After endLap above, so getReference() reflects this lap's just-
        // promoted ghost samples rather than the previous best's.
        savePersonalBest(track.id, {
          schemaVersion: 1,
          bestLapSeconds: lap.lastLapSeconds,
          ghost: ghostRecorderRef.current.getReference() ?? [],
        }).catch(() => {});
      }
      // Completes the final sector for the lap that just ended (see
      // sectorTimer.ts's own comment for why this is driven by the lap
      // timer's crossing rather than a third progress-based gate). The
      // display is deliberately NOT cleared here - the just-finished
      // lap's three splits stay on screen (S3 is otherwise never visible
      // at all, since it completes at the exact instant the lap ends) and
      // each slot is naturally overwritten as the new lap's own sectors
      // complete in turn.
      const finalSplit = sectorTimerRef.current.onLapEnd(lap.lastLapSeconds, eligible, wasNewBest);
      sectorResultsRef.current[finalSplit.sectorIndex] = finalSplit;
      renderSectors();
      lapHadDiscontinuityRef.current = false;
      qualifyingDiscontinuityRef.current = false;
      lapInvalidRef.current = false;
      lapInvalidAtSecondsRef.current = null;
      resetTrackLimitLap(trackLimitSequenceRef.current);
    }

    if (sessionMode === "race" && hudRef?.current && raceRef?.current && hudRef.current.result === null) {
      updateRaceFinish(lap.lapCount, dt);
      updateFlags(dt, lap);
    }

    const sectorCrossing = sectorTimerRef.current.update(t.x, t.z, lap.currentLapSeconds, eligible);
    if (sectorCrossing) {
      sectorResultsRef.current[sectorCrossing.sectorIndex] = sectorCrossing;
      renderSectors();
    }

    if (hudRef?.current) {
      const hud = hudRef.current;
      const session = qualiSessionRef.current;
      hud.sessionMode = sessionMode;
      hud.timeAttack = timeAttack;
      hud.lap = sessionMode === "practice" ? Math.min(lap.lapCount + 1, raceLaps) : lap.lapCount + 1;
      hud.totalLaps = sessionMode === "qualifying" ? 0 : raceLaps;
      hud.lapSeconds = lap.currentLapSeconds;
      hud.lastLapSeconds = lap.lastLapSeconds;
      hud.bestLapSeconds = sessionMode === "qualifying" ? session.best.player : bestLapRef.current;
      hud.lapInvalid = lapInvalidRef.current;
      // Qualifying clock: a time attack has no deadline, so no clock at all.
      const timed = sessionMode === "qualifying" && !timeAttack && qualiFormat !== "oneshot";
      hud.clockSeconds = timed
        ? qualiFormat === "knockout"
          ? session.phaseTimeLeftSeconds
          : session.timeLeftSeconds
        : null;
      hud.phase = timeAttack
        ? "TIME ATTACK"
        : sessionMode === "qualifying"
          ? qualiFormat === "oneshot"
            ? "ONE-SHOT QUALIFYING"
            : (session.phase ?? "QUALIFYING")
          : sessionMode === "practice"
            ? "PRACTICE"
            : null;
    }

    if (sessionMode === "qualifying" && !qualiFinishedRef.current) {
      // TIME ATTACK NEVER TICKS. The qualifying session machine is what counts
      // the clock down and flips `finished`, so simply not calling it is the
      // whole of the "unlimited time" behaviour - there is no second clock to
      // also forget to stop. The best lap still updates, because that is
      // recordQualiLap's job at the finish line above, not this function's.
      const ticking = !timeAttack && (qualiFormat === "timed" || qualiFormat === "knockout");
      if (ticking) {
        const prevPhase = qualiSessionRef.current.phase;
        const wasEliminated = qualiSessionRef.current.playerEliminated;
        qualiSessionRef.current = tickQualifyingSession(qualiSessionRef.current, dt);
        // Knockout phase-transition toasts: the player's own fate is the
        // story (cut, or through to the next phase).
        if (qualiFormat === "knockout") {
          const session = qualiSessionRef.current;
          let toast: string | null = null;
          if (session.playerEliminated && !wasEliminated) {
            toast = `ELIMINATED IN ${session.phase ?? "Q1"} - P${gridSpotFromSession(session)} ON THE GRID`;
          } else if (session.phase !== null && session.phase !== prevPhase) {
            toast = session.phase === "Q3" ? "THROUGH TO Q3 - TOP TEN SHOOTOUT" : `THROUGH TO ${session.phase}`;
          }
          if (toast && hudRef?.current) {
            pushHudEvent(hudRef.current, session.playerEliminated ? "warn" : "good", toast, undefined, 3.5);
          }
        }
      }
      if (qualiSessionRef.current.finished && hudRef?.current) {
        qualiFinishedRef.current = true;
        // Player-only qualifying keeps the rival reference times in the
        // shared board (see Scene.tsx); race mode still fills that board
        // live from AICar. The session machine itself only records the
        // player's laps, so merge the two sources at the classification
        // boundary.
        const sharedBests = qualifyingRef?.current?.opponents ?? [];
        const mergedBest = {
          player: qualiSessionRef.current.best.player,
          opponents: rivals.map((_, k) => sharedBests[k] ?? null),
        };
        const spot = gridSpotFromSession({ ...qualiSessionRef.current, best: mergedBest });
        if (champRound !== null) {
          recordChampionshipQuali(champRound, spot).catch(() => {});
        }
        // Full grid order for the race link (see ?order=): every car
        // lines up where it qualified, not just the player.
        const gridOrder = sessionGridOrder(
          mergedBest,
          playerCode,
          rivals.map((rival) => rival.code)
        );
        const raceHref = retargetSessionUrl(window.location.search, "race", spot, gridOrder);
        // The full hidden AI reference field is now shown as a proper
        // classification, including each driver's gap to the player's lap.
        hudRef.current.result = {
          kind: "qualifying",
          position: spot,
          playerTime: mergedBest.player,
          rows: qualifyingRows({ times: mergedBest, playerCode, playerName, playerColor: bodyColor, rivals }),
          raceHref,
          champRound,
        };
      }
    }

    const delta = deltaTrackerRef.current.recordSample(tracked.progressMeters, lap.currentLapSeconds);
    if (hudRef?.current) hudRef.current.delta = delta;

    ghostRecorderRef.current.recordSample(lap.currentLapSeconds, {
      position: { x: t.x, y: t.y, z: t.z },
      rotation: { x: bodyRot.x, y: bodyRot.y, z: bodyRot.z, w: bodyRot.w },
    });
    if (ghostGroupRef.current) {
      const ghostPose = ghostRecorderRef.current.poseAt(lap.currentLapSeconds);
      if (ghostPose) {
        ghostGroupRef.current.visible = true;
        ghostGroupRef.current.position.set(ghostPose.position.x, ghostPose.position.y, ghostPose.position.z);
        ghostGroupRef.current.quaternion.set(
          ghostPose.rotation.x,
          ghostPose.rotation.y,
          ghostPose.rotation.z,
          ghostPose.rotation.w
        );
      } else {
        ghostGroupRef.current.visible = false;
      }
    }

    if (raceOpsSnapshotRef) {
      raceOpsSnapshotRef.current = {
        weather: weatherStateRef.current,
        strategy: strategyStateRef.current,
        energyMode: energyStatusRef.current.mode,
        batteryFraction: energyStatusRef.current.batteryFraction,
        deploymentBudgetFraction: energyStatusRef.current.deploymentBudgetFraction,
        overtake: overtakeStateRef.current,
        raceControl: effectiveRaceControlRef.current.snapshot(),
        replay: replayRef.current.state(),
        telemetry: replayRef.current.telemetryTrace(80),
      };
    }

    if (hudRef?.current) {
      const hud = hudRef.current;
      hud.trackLimitText = allFourWheelsOff
        ? trackLimitStageLabel(trackLimitSequenceRef.current.stage, trackLimitSequenceRef.current.offenses + 1)
        : "";
      hud.offTrack = allFourWheelsOff;
      hud.x = t.x;
      hud.z = t.z;
      hud.yaw = yawFromQuaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
    }
  });

  return (
    <>
      <group ref={ghostGroupRef} visible={false}>
        <F1CarBody
          bodyColor={bodyColor}
          accentColor={accentColor}
          steerRefs={ghostSteerRefs}
          spinRefs={ghostSpinRefs}
          ghost
        />
      </group>
      <RigidBody
        ref={chassisRef}
        colliders={false}
        position={[gridSpot.x, gridSpot.y, gridSpot.z]}
        rotation={[0, gridSpot.headingRad, 0]}
        linearDamping={LINEAR_DAMPING}
        angularDamping={ANGULAR_DAMPING}
        canSleep={false}
        onContactForce={(payload: ContactForcePayload) => {
          const chassis = chassisRef.current;
          if (chassis) {
            const rot = chassis.rotation();
            const yawNow = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
            const fx = -Math.sin(yawNow);
            const fz = -Math.cos(yawNow);
            const d = payload.maxForceDirection;
            const zone = classifyHit({ forward: d.x * fx + d.z * fz, right: d.x * fz - d.z * fx, up: d.y });
            if (applyComponentDamage(damageRef.current, zone, payload.totalForceMagnitude, damageModeRef.current, hitCountRef.current++)) {
              setDamage(damageRef.current);
            }
          }
          // Thump for the race audio rig (see app/race/RaceAudioRig.tsx) -
          // same force scale as the damage model, so only chassis-scale hits
          // speak.
          if (audioRef) {
            const strength = impactGain01(payload.totalForceMagnitude);
            if (strength > 0) {
              audioRef.current.impact = { strength01: strength, atMs: performance.now() };
            }
          }
          // A collision is the single most useful thing to see marked on the
          // flashback strip - it is nearly always what the player is scrubbing
          // back to find. Latched here and consumed by the next trace sample,
          // because a contact is a single-step event and the trace decimates
          // to 10Hz, so recording it directly would drop almost all of them.
          if (payload.totalForceMagnitude > FLASHBACK_CONTACT_FORCE_N) {
            flashbackContactRef.current = true;
          }
        }}
      >
        {/*
          colliders={false} + one explicit collider is deliberate: the
          default auto-collider generation ("cuboid") walks every visible
          mesh under this RigidBody and gives EACH one its own bounding-box
          collider - including the 4 wheel cylinder meshes below, which were
          silently getting solid, chassis-fixed collision boxes sitting right
          where the ground is, fighting the raycast suspension on every wheel.
          That was the real cause of the violent launching/flipping reported
          during play - a headless harness with no meshes at all could never
          have caught it. Only the chassis body should ever be solid.
        */}
        <CuboidCollider args={CHASSIS_HALF_EXTENTS} mass={CHASSIS_MASS} />
        <group ref={visualRef}>
          <F1CarBody
            bodyColor={bodyColor}
            accentColor={accentColor}
            steerRefs={steerRefs}
            spinRefs={spinRefs}
            flapRef={flapRef}
            damageRef={damageRef}
            compoundRef={tireCompound}
            raceNumber={playerNumber ?? null}
          />
        </group>
        <SteeringWheel wheelRef={steeringWheelRef} />
        <HelmetCockpit interiorRef={helmetCockpitRef} />
      </RigidBody>
    </>
  );
}
