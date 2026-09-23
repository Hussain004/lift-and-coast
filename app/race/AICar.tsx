"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import {
  CuboidCollider,
  RigidBody,
  useRapier,
  useBeforePhysicsStep,
  type RapierRigidBody,
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
  computeStabilizingTorque,
  createCarController,
  resolveYawDampingTorque,
  wheelGroundPositions,
  yawFromQuaternion,
} from "@/lib/physics/vehicle";
import { computeDownforceN } from "@/lib/physics/aero";
import { createGearboxState, rpmForGear } from "@/lib/physics/gearbox";
import { F1CarBody } from "./F1CarBody";
import { checkTrackLimits, allWheelsOffTrack, worldEdgeResetMeters } from "@/lib/tracks/trackLimits";
import {
  meanSurfaceDrag,
  sampleSurface,
  wheelSurfaceGrips,
} from "@/lib/tracks/surfaces";
import { getLineRoom, getRacingLine } from "@/lib/tracks/racingLineCache";
import type { ThrottleZone } from "@/lib/tracks/racingLine";
import { computeAIControls, nearestLineIndex } from "@/lib/ai/pathFollower";
import { createEnergySystem } from "@/lib/physics/energy";
import {
  difficultyAggressionShift,
  difficultyMistakeScale,
  difficultyPaceScale,
  hashDriverCode,
  mulberry32,
  tireCurveMultiplier,
  traitsForDriver,
  type AIDifficulty,
} from "@/lib/ai/personalities";
import {
  createRacecraftState,
  lateralAtLineIndex,
  lineContextAt,
  lineDirectionAt,
  lineIndexAtProgress,
  refineGap,
  resetRacecraftState,
  stepRacecraft,
  unwrapGap,
  type FieldCarView,
} from "@/lib/ai/racecraft";
import {
  createRecoveryState,
  findRecoveryIndex,
  recoveryPose,
  updateRecovery,
} from "@/lib/ai/recovery";
import type { NetPoseState } from "./NetSync";
import { createLapTimer, LINE_HALF_WIDTH_METERS } from "@/lib/race/lapTimer";
import { createProgressTracker, trackProgress } from "@/lib/race/progressTracker";
import {
  applySnapshot,
  createRewindBuffer,
  REWIND_CAPACITY_SECONDS,
  snapshotOf,
} from "@/lib/race/rewindBuffer";
import { gridSlot } from "@/lib/race/grid";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import { rpmTo01, skidAmount01 } from "@/lib/audio/raceAudio";
import type { RaceState } from "@/lib/race/racePosition";
import type { QualifyingTimes } from "@/lib/race/qualifying";
import type { CarPose } from "@/lib/net/snapshots";
import type { TrackData } from "@/lib/tracks/types";

/**
 * One AI opponent (plan section 6 depth: AI field), instanced once per
 * rival by Scene.tsx: follows the same ideal-line approximation drawn for
 * the player (lib/tracks/racingLine.ts) using pure-pursuit steering and
 * curvature-derived speed targets (lib/ai/pathFollower.ts), running the
 * identical vehicle rig as the player's own car (Car.tsx) so it's bound
 * by the same physics.
 *
 * Every rival drives its own deterministic personality (see
 * lib/ai/personalities.ts: pace spread, aggression, risk, tire curve) on
 * the meeting's difficulty tier, and races the cars around it (see
 * lib/ai/racecraft.ts: slipstream, follow lifts, straight-line overtakes
 * with a bounded offset, yielding) - the field spreads, shuffles and
 * passes instead of holding formation. All of it acts through pace levers
 * and one straights-only lateral offset: the steering/lookahead control
 * law itself is identical for every car (see pathFollower.ts on why that
 * law is never retuned per driver).
 *
 * Deliberately owns its own chassis/visual/controller refs rather than
 * sharing anything with Scene.tsx's player refs - ChaseCamera follows
 * Scene.tsx's visualRef, and this car must never become that target.
 *
 * Tracks its own lap count (plan section 7's Quick Race), writing into
 * its slot of the shared raceRef so Car.tsx can rank the full field
 * without either car needing a ref into the other's internals. Also
 * writes its own world position into its minimap dot each frame (a plain
 * SVG circle, not the rotating egocentric marker the player gets - see
 * page.tsx). In qualifying sessions its best valid lap feeds the shared
 * qualifying times (see the validity latch below) so the grid reflects
 * clean laps only.
 */
/**
 * Seeded per-race RNG for one car (see sessionSeedRef): recreated when the
 * seed key changes (mount stamps the random seed just after first render),
 * which also clears any armed mistake - reseeds only ever happen before
 * the start lights, never mid-race.
 */
function sessionRng(
  sessionSeed: number,
  driverCode: string,
  refs: {
    rng: React.RefObject<(() => number) | null>;
    seed: React.RefObject<number>;
    armed: React.RefObject<boolean>;
    timeLeft: React.RefObject<number>;
  }
): () => number {
  const key = (sessionSeed ^ hashDriverCode(driverCode)) >>> 0;
  if (refs.rng.current === null || refs.seed.current !== key) {
    refs.rng.current = mulberry32(key);
    refs.seed.current = key;
    refs.armed.current = false;
    refs.timeLeft.current = 0;
  }
  return refs.rng.current;
}

export function AICar({
  track,
  raceRef,
  minimapMarkerEls,
  raceStartRef,
  qualifyingRef,
  sharedRewindActiveRef,
  gridSlotIndex = 1,
  aiIndex = 0,
  /** This rival's FIA code - selects its deterministic personality (pace,
   * aggression, risk, tire curve, passing side; see personalities.ts). */
  driverCode = "YOU",
  /** Meeting difficulty tier (see personalities.ts) - scales AI pace and
   * aggression only; the player's car is untouched. */
  difficulty = "pro" as AIDifficulty,
  /** Per-race random seed (see Scene.tsx) - mistake scheduling only; the
   * traits themselves are session-stable so the same code always has the
   * same character. */
  sessionSeedRef,
  /** Total race laps (see Scene.tsx) - the tire curve's clock. */
  raceLaps = 3,
  trafficRef,
  trafficKey,
  netInputRef,
  netPoseRef,
  carPosesRef,
  bodyColor = "#ff5a3c",
  audioRef,
}: {
  track: TrackData;
  raceRef?: React.RefObject<RaceState>;
  /**
   * One minimap dot per rival, written by index (see aiIndex) - plain SVG
   * circles inside the same rotating group as the track path (see
   * page.tsx), so they inherit the egocentric transform for free.
   */
  minimapMarkerEls?: React.RefObject<(SVGCircleElement | null)[]>;
  /** Grid start (Scene.tsx) - throttle is locked out while false. */
  raceStartRef?: React.RefObject<boolean>;
  /**
   * Written by Car.tsx while the player holds the rewind key (see
   * Scene.tsx) - this car scrubs its own past alongside the player's so
   * a flashback rewinds the whole world. Each car keeps its own cursor
   * in lockstep from the same flag (same timestep, same capacity), so no
   * ordering between the two physics steps matters.
   */
  sharedRewindActiveRef?: React.RefObject<boolean>;
  /** Playable Qualifying (see lib/race/qualifying.ts) - shared with Car.tsx. */
  qualifyingRef?: React.RefObject<QualifyingTimes>;
  /**
   * This car's grid slot (0-based, see gridSlot in grid.ts) and index
   * among the rivals (see resolveFieldRoster) - the scene assigns slots
   * from the qualifying order, or staggered-from-pole without one.
   */
  gridSlotIndex?: number;
  aiIndex?: number;
  /**
   * This rival's FIA code - selects its deterministic personality (pace,
   * aggression, risk, tire curve, passing side; see personalities.ts).
   */
  driverCode?: string;
  /**
   * Meeting difficulty tier (see personalities.ts) - scales AI pace and
   * aggression only; the player's car is untouched.
   */
  difficulty?: AIDifficulty;
  /**
   * Per-race random seed (see Scene.tsx's sessionSeedRef) - mistake
   * scheduling only; the traits themselves are session-stable so the same
   * code always has the same character. Read live every tick through the
   * ref, so dealing the seed needs no re-render.
   */
  sessionSeedRef?: React.RefObject<number>;
  /** Total race laps (see Scene.tsx) - the tire curve's clock. */
  raceLaps?: number;
  /**
   * Live traffic table (see Scene.tsx): this car reports its world
   * position here every physics tick under trafficKey, and reads the
   * table to place slow/stopped obstacles laterally (see
   * squeezeDecision) instead of guessing from the line.
   */
  trafficRef?: React.RefObject<Record<string, { x: number; z: number }>>;
  trafficKey?: string;
  /**
   * Remote-human driving (plan section 16): when present, this car is a
   * guest's car simulated on the host - inputs come over the net instead
   * of the path follower, always with auto gears (a guest's manual shifts
   * don't cross the wire; pace matches to within gearing). Stale input
   * (guest lagged or gone >500ms) falls back to the path follower, so a
   * dropped guest's car keeps racing as AI instead of parking on track.
   * Absent entirely for solo AI (and every AI on guests, which don't
   * simulate at all).
   */
  netInputRef?: React.RefObject<{ throttle: number; brake: number; steer: number; atMs: number } | null>;
  /**
   * The guest's own pose for this car (see NetSync's NetPoseState), written
   * by NetHost on its "pose" stream. The host's simulation is the shared
   * truth, but a guest is the final word on its own car, so a divergence
   * beyond a few metres is nudged out here (never a teleport) - that is
   * what keeps the guest's screen and everyone else's agreeing instead of
   * fighting, which is what the pre-fix jitter was.
   */
  netPoseRef?: React.RefObject<NetPoseState | null>;
  /**
   * Per-slot pose table (see Scene.tsx) - written every physics tick for
   * the host's snapshot broadcast. Keyed by grid slot (see gridSlotIndex).
   */
  carPosesRef?: React.RefObject<Record<number, CarPose>>;
  /** Garage pick (see lib/race/roster.ts) - this rival's own team livery. */
  bodyColor?: string;
  /** Shared with the race audio rig (see app/race/RaceAudioRig.tsx) - this
   * car fills in the opponent half every render frame from live telemetry. */
  audioRef?: React.RefObject<AudioSnapshot>;
}) {
  const { world, rapier } = useRapier();
  const chassisRef = useRef<RapierRigidBody>(null);
  const controllerRef = useRef<Rapier.DynamicRayCastVehicleController | null>(null);
  // Auto gearbox (plan section 5 depth feature 4): the AI shifted by the
  // same rpm policy as the player's auto-assist - always auto, the AI never
  // drives in manual mode.
  const gearboxRef = useRef(createGearboxState(true));
  // Latest gated controls for the audio snapshot below - recomputing
  // computeAIControls in useFrame would pay a second nearest-line scan per
  // render frame on top of the physics step's own.
  const lastControlsRef = useRef({ throttle: 0, yaw: 0, lvx: 0, lvz: 0 });
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const lapTimerRef = useRef(
    createLapTimer({
      startPos: track.startPos,
      lineHalfWidth: LINE_HALF_WIDTH_METERS,
      startsBehindLine: gridSlot(track, gridSlotIndex).startsBehindLine,
    })
  );
  // Validity latch for the shared qualifying times (mirrors the player's
  // lapInvalidRef in Car.tsx): any all-four-off moment taints the current
  // lap, and the latch resets on every crossing so each lap is judged on
  // its own driving.
  const aiLapInvalidRef = useRef(false);
  // When (on the lap clock) the current taint happened - lets a rewind
  // that reaches back past the violation undo it, mirroring the player's
  // lapInvalidAtSecondsRef in Car.tsx.
  const aiLapInvalidAtSecondsRef = useRef<number | null>(null);
  // Flashback state (see sharedRewindActiveRef): same scrub/resume/lap-
  // rollback discipline as the player's own car in Car.tsx.
  const aiBufferRef = useRef(createRewindBuffer(REWIND_CAPACITY_SECONDS, 1 / 60));
  // Progress continuity (see progressTracker.ts): rank and racecraft
  // read tracked progress, never the flicker-prone scan, at the seam.
  const progressTrackerRef = useRef(createProgressTracker());
  // Push-to-Pass battery + strategy state (see lib/ai/racecraft.ts's
  // shouldDeployBoost): the same harvest-under-braking / deploy-on-
  // straights system the player's Car.tsx runs, same constraints per the
  // plan's 2026 rules. boostEligible rides one tick behind (same pattern
  // as zoneRef above) - one tick of lag at 60Hz is nothing next to a
  // multi-second deploy.
  const energyRef = useRef(createEnergySystem());
  const batteryRef = useRef(1);
  const boostEligibleRef = useRef(false);
  const aiCursorRef = useRef(0);
  const aiWasRewindingRef = useRef(false);
  // Personality (see driverCode/difficulty/sessionSeedRef): traits are a
  // function of the driver code, so plain consts - no refs read during
  // render. Props are mount-stable (Scene remounts on track/rivals/
  // difficulty change), so these never go stale.
  const traits = traitsForDriver(driverCode);
  const aggression = Math.min(1, Math.max(0, traits.aggression + difficultyAggressionShift(difficulty)));
  // Racecraft state (see lib/ai/racecraft.ts): lateral offset ramp, attack
  // and defence latches, the launch clock. Recovery (lib/ai/recovery.ts)
  // puts a beached or upside-down car back on the line. The zone is last
  // tick's (one tick of lag at 60Hz is nothing next to a pass).
  const racecraftRef = useRef(createRacecraftState());
  const recoveryRef = useRef(createRecoveryState());
  const zoneRef = useRef<ThrottleZone>("throttle");
  const rngRef = useRef<(() => number) | null>(null);
  const rngSeedRef = useRef(-1);
  const mistakeArmedRef = useRef(false);
  const mistakeAtMetersRef = useRef(0);
  const mistakeTimeLeftRef = useRef(0);
  // Warm-started nearest-line search (see nearestLineIndex): this car's
  // last anchor index. The anchor now computes once per tick above the
  // input branch (the racecraft book and computeAIControls share it), so
  // both per-tick full-line scans collapse into one windowed one.
  const nearestIdxRef = useRef(0);

  const racingLine = useMemo(() => getRacingLine(track), [track]);
  const lineRoom = useMemo(() => getLineRoom(track), [track]);

  const { spawnX, spawnY, spawnZ, spawnQuat } = useMemo(() => {
    const grid = gridSlot(track, gridSlotIndex);
    const yaw = track.startPos.headingRad;
    return {
      spawnX: grid.x,
      spawnY: grid.y,
      spawnZ: grid.z,
      spawnQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    };
  }, [track, gridSlotIndex]);

  useEffect(() => {
    const body = chassisRef.current;
    if (!body) return;
    const controller = createCarController(rapier, world, body);
    controllerRef.current = controller;
    return () => {
      world.removeVehicleController(controller);
      controllerRef.current = null;
    };
  }, [rapier, world]);

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;

    // Guest pose reconciliation (see netPoseRef): a guest's car is
    // simulated here from its inputs, but the guest is driving its own copy
    // at the same time - if the two part ways (a contact resolved
    // differently, a starved input stretch), the guest's copy is the one
    // they are looking at. Blend a third of the way across on gross
    // divergence only; inside 3m, leave it alone, because nudging tiny
    // differences every tick is what reads as jitter. Skipped entirely when
    // the guest has gone quiet - then this car is AI-driven (see netFresh
    // below) and the pose we hold is a stale relic.
    const guestPose = netPoseRef?.current ?? null;
    if (guestPose) {
      const guestInput = netInputRef?.current ?? null;
      const guestActive = guestInput !== null && Date.now() - guestInput.atMs < 500;
      if (guestActive && Date.now() - guestPose.atMs < 500) {
        const cur = body.translation();
        const gp = guestPose.pose.position;
        const dx = gp[0] - cur.x;
        const dy = gp[1] - cur.y;
        const dz = gp[2] - cur.z;
        if (Math.hypot(dx, dy, dz) > 3) {
          body.setTranslation(
            { x: cur.x + dx * 0.33, y: cur.y + dy * 0.33, z: cur.z + dz * 0.33 },
            true
          );
        }
      }
    }

    const pos = body.translation();
    const limitStatus = checkTrackLimits(track, pos.x, pos.z, pos.y);
    // Ranked/decision progress comes from the continuity tracker (see
    // progressTracker.ts), never the raw scan: at the start/finish seam
    // the scan flickers between ~0 and ~trackLength, hiding cars on the
    // line from followers (full-speed rams) and slingshotting the tower.
    const trackedProgress = trackProgress(track, pos.x, pos.z, progressTrackerRef.current, pos.y).progressMeters;
    // Same safety backstop as the player's car (Car.tsx) - without it, a
    // path-follower bug or a bad launch could leave the AI stuck off-course
    // or run it past the finite ground field's edge for the rest of the
    // session with nothing to recover it. The finiteness guard is load-
    // bearing: a dense pack can grind the contact solver into NaN (seen as
    // a frozen frame plus dead WASM on 20-car Suzuka starts), and NaN
    // spreads car-to-car within ticks - so a poisoned car blinks back to
    // its grid slot with zeroed velocities BEFORE the next step, and the
    // rest of the field never notices.
    const lv0 = body.linvel();
    const rt0 = body.rotation();
    if (
      !Number.isFinite(pos.x + pos.y + pos.z + lv0.x + lv0.y + lv0.z + rt0.x + rt0.y + rt0.z + rt0.w) ||
      limitStatus.distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > worldEdgeResetMeters(track)
    ) {
      body.setTranslation({ x: spawnX, y: spawnY, z: spawnZ }, true);
      body.setRotation({ x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      // Same stale-buffer guard as the player's own reset in Car.tsx: a
      // reset that lands mid-rewind must not resume back out to the
      // pre-reset snapshot on release.
      aiWasRewindingRef.current = false;
      aiCursorRef.current = 0;
      resetRacecraftState(racecraftRef.current);
      return;
    }

    // Flashback (see sharedRewindActiveRef): scrub while the player holds
    // R, resume on release - same discipline as Car.tsx, so both cars land
    // back on the same scrubbed timeline.
    if (sharedRewindActiveRef?.current ?? false) {
      aiWasRewindingRef.current = true;
      aiCursorRef.current = Math.min(
        aiCursorRef.current + world.timestep,
        aiBufferRef.current.oldestAvailableSeconds()
      );
      const sample = aiBufferRef.current.sampleAt(aiCursorRef.current);
      if (sample) applySnapshot(body, sample, true);
      return;
    }

    if (aiWasRewindingRef.current) {
      const sample = aiBufferRef.current.resumeFrom(aiCursorRef.current);
      if (sample) applySnapshot(body, sample, false);
      // Roll the lap clock back by the scrubbed time (see Car.tsx), and
      // clear a track-limits taint only if the rollback actually reaches
      // the violation - same rule as the player's lapInvalidRef.
      const rolledBackTo = lapTimerRef.current.rewindBy(aiCursorRef.current);
      if (aiLapInvalidAtSecondsRef.current === null || rolledBackTo <= aiLapInvalidAtSecondsRef.current) {
        aiLapInvalidRef.current = false;
        aiLapInvalidAtSecondsRef.current = null;
      }
      aiCursorRef.current = 0;
      aiWasRewindingRef.current = false;
      resetRacecraftState(racecraftRef.current);
    }

    // Grid start (Scene.tsx) - same reasoning as Car.tsx's identical guard:
    // the lap timer accumulates currentLapSeconds every tick regardless of
    // whether the car is actually moving, so it must not run during the
    // countdown (the AI is held stationary by the throttle gate below too).
    if (raceStartRef?.current ?? true) {
      const lap = lapTimerRef.current.update({ x: pos.x, z: pos.z }, world.timestep);
      if (raceRef?.current) {
        const opponents = raceRef.current.opponents;
        while (opponents.length <= aiIndex) {
          opponents.push({ lapCount: 0, progressMeters: 0, speedMs: 0 });
        }
        const rotNow = body.rotation();
        opponents[aiIndex] = {
          lapCount: lap.lapCount,
          progressMeters: trackedProgress,
          speedMs: computeSignedForwardSpeed(
            body.linvel(),
            yawFromQuaternion(rotNow.x, rotNow.y, rotNow.z, rotNow.w)
          ),
        };
      }
      // Playable Qualifying: the AI's best VALID lap, feeding the same
      // shared times the player writes (see Car.tsx) so the grid compares
      // clean laps on both sides. Unconditional on mode - in a race the
      // overlay simply compares bests instead of first laps.
      if (allWheelsOffTrack(track, wheelGroundPositions(body))) {
        if (!aiLapInvalidRef.current) {
          aiLapInvalidAtSecondsRef.current = lap.currentLapSeconds;
        }
        aiLapInvalidRef.current = true;
      }
      if (lap.crossedFinishLine && lap.lastLapSeconds !== null) {
        if (qualifyingRef?.current && !aiLapInvalidRef.current) {
          const times = qualifyingRef.current.opponents;
          while (times.length <= aiIndex) times.push(null);
          const prev = times[aiIndex];
          if (prev === null || lap.lastLapSeconds < prev) {
            times[aiIndex] = lap.lastLapSeconds;
          }
        }
        aiLapInvalidRef.current = false;
        // Mistake scheduling (see personalities.ts): one seeded draw per
        // lap decides whether this driver has a moment this time round,
        // and where. Risky drivers err most laps, metronomes almost never.
        const rng = sessionRng(sessionSeedRef?.current ?? 0, driverCode, {
          rng: rngRef,
          seed: rngSeedRef,
          armed: mistakeArmedRef,
          timeLeft: mistakeTimeLeftRef,
        });
        mistakeArmedRef.current =
          rng() < (0.12 + traits.risk * 0.35) * difficultyMistakeScale(difficulty);
        mistakeAtMetersRef.current = rng() * track.lengthMeters;
      }
    }

    const rot = body.rotation();
    const yaw = yawFromQuaternion(rot.x, rot.y, rot.z, rot.w);
    // Not controller.currentVehicleSpeed() - see computeSignedForwardSpeed's
    // own comment for why that reads the wrong sign at sustained high speed
    // on the real trimesh, which would otherwise feed garbage into both the
    // path follower's target-speed logic and applyCarControls' steer-scale/
    // traction-control gating.
    const speedMs = computeSignedForwardSpeed(body.linvel(), yaw);
    // Remote-human driving (see netInputRef): fresh guest input wins, and
    // the human drives - no personality, no racecraft. Stale or absent
    // input falls back to the path follower below, so this car is always
    // a real AI opponent even with no guest attached.
    const netInput = netInputRef?.current ?? null;
    const netFresh = netInput !== null && Date.now() - netInput.atMs < 500;
    let controls: { throttle: number; brake: number; steer: number };
    // Push-to-Pass multiplier (1 = not deploying). Only the AI branch ever
    // sets it: a guest-driven car has no battery wiring over the wire, so
    // it keeps the legacy flat 1.
    let boostMultiplier = 1;
    if (netFresh && netInput) {
      controls = { throttle: netInput.throttle, brake: netInput.brake, steer: netInput.steer };
    } else {
      // Personality pace (see personalities.ts): driver skill times the
      // meeting tier times the tire curve, so the field spreads over a
      // race and early flyers can fade while late specialists come alive.
      const myEntry = raceRef?.current?.opponents[aiIndex];
      const myLap = myEntry?.lapCount ?? 0;
      const raceProgress = Math.min(1, Math.max(0, myLap / Math.max(1, raceLaps)));
      let paceMult =
        traits.pace * difficultyPaceScale(difficulty) * tireCurveMultiplier(traits.latePace, raceProgress);
      // Mistake envelope: an armed moment triggers when the car reaches
      // the scheduled point, then reads as a lift for under a second -
      // pace only, the steering never wavers.
      if (mistakeArmedRef.current && trackedProgress >= mistakeAtMetersRef.current) {
        mistakeArmedRef.current = false;
        const rng = sessionRng(sessionSeedRef?.current ?? 0, driverCode, {
          rng: rngRef,
          seed: rngSeedRef,
          armed: mistakeArmedRef,
          timeLeft: mistakeTimeLeftRef,
        });
        mistakeTimeLeftRef.current = 0.5 + rng() * 0.6;
      }
      if (mistakeTimeLeftRef.current > 0) {
        mistakeTimeLeftRef.current = Math.max(0, mistakeTimeLeftRef.current - world.timestep);
        paceMult = Math.min(paceMult, 0.85);
      }
      // The field around this car in the line frame (see racecraft.ts):
      // seam-unwrapped gaps (exact within 25m), each car's lateral at its
      // own place on the line, and raw race distance for blue flags. Keys
      // stay stable ("p", "o{k}") so a latched attack tracks its target.
      const anchor = nearestLineIndex(racingLine, pos.x, pos.z, nearestIdxRef.current);
      nearestIdxRef.current = anchor;
      const dir = lineDirectionAt(racingLine, anchor);
      const cars: FieldCarView[] = [];
      const race = raceRef?.current;
      if (race) {
        const traffic = trafficRef?.current;
        const n = racingLine.length;
        const view = (key: string, trafficKeyOf: string, entry: RaceState["player"]): void => {
          const at = traffic?.[trafficKeyOf];
          const coarse = unwrapGap(myLap, trackedProgress, entry.lapCount, entry.progressMeters, track.lengthMeters);
          cars.push({
            key,
            gapMeters: at ? refineGap(coarse, pos.x, pos.z, at.x, at.z, dir.x, dir.z) : coarse,
            rawGapMeters:
              (entry.lapCount - myLap) * track.lengthMeters + (entry.progressMeters - trackedProgress),
            speedMs: entry.speedMs ?? 0,
            lateralMeters: at
              ? lateralAtLineIndex(
                  racingLine,
                  lineIndexAtProgress(entry.progressMeters, track.lengthMeters, n),
                  at.x,
                  at.z
                )
              : null,
          });
        };
        view("p", "p", race.player);
        for (let k = 0; k < race.opponents.length; k++) {
          if (k !== aiIndex) view(`o${k}`, `a${k}`, race.opponents[k]);
        }
      }
      const racecraft = racecraftRef.current;
      if (raceStartRef?.current ?? true) racecraft.raceSeconds += world.timestep;
      // Wheel-to-wheel driving (see stepRacecraft): the shared step the
      // headless field gates run in lockstep, so live behavior and test
      // behavior cannot drift apart.
      const step = stepRacecraft(racecraft, {
        ownSpeedMs: speedMs,
        ownLateralMeters: lateralAtLineIndex(
          racingLine,
          lineIndexAtProgress(trackedProgress, track.lengthMeters, racingLine.length),
          pos.x,
          pos.z
        ),
        basePace: paceMult,
        cars,
        line: lineContextAt(racingLine, lineRoom, anchor, Math.abs(speedMs), paceMult, zoneRef.current),
        aggression,
        risk: traits.risk,
        overtakeSide: traits.overtakeSide,
        dt: world.timestep,
        trackLengthMeters: track.lengthMeters,
        boostEligible: boostEligibleRef.current,
        batteryFraction: batteryRef.current,
        mistakeActive: mistakeTimeLeftRef.current > 0,
      });
      paceMult = step.paceMult;
      const willDeploy = step.deploy;
      // Beached, wedged or upside down (see lib/ai/recovery.ts): back onto
      // the line at its own progress once the road there is clear.
      const up = body.rotation();
      if (
        updateRecovery(recoveryRef.current, {
          racing: raceStartRef?.current ?? true,
          speedMs,
          upY: 1 - 2 * (up.x * up.x + up.z * up.z),
          blocked: step.blocked,
          dt: world.timestep,
        })
      ) {
        const at = findRecoveryIndex(
          racingLine,
          anchor,
          cars.map((car) => car.gapMeters)
        );
        if (at !== null) {
          const pose = recoveryPose(racingLine, at);
          body.setTranslation({ x: pose.x, y: pose.y, z: pose.z }, true);
          body.setRotation({ x: 0, y: Math.sin(pose.yaw / 2), z: 0, w: Math.cos(pose.yaw / 2) }, true);
          body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          recoveryRef.current = createRecoveryState();
          resetRacecraftState(racecraft);
          aiLapInvalidRef.current = true;
          return;
        }
      }
      const aiControls = computeAIControls(
        racingLine,
        pos.x,
        pos.z,
        yaw,
        speedMs,
        willDeploy,
        paceMult,
        step.steerOffsetMeters,
        // The anchor above is this car's nearest line point at this exact
        // position - passing it makes the internal scan a confirmed
        // windowed hit (distance 0) instead of a second full-line scan.
        anchor
      );
      zoneRef.current = aiControls.zone;
      boostEligibleRef.current = aiControls.boostEligible;
      const energyStatus = energyRef.current.update(
        { brakeAmount: aiControls.brake, deployRequested: willDeploy },
        world.timestep
      );
      batteryRef.current = energyStatus.batteryFraction;
      boostMultiplier = energyStatus.engineForceMultiplier;
      controls = aiControls;
    }

    // Grid start (Scene.tsx) - see Car.tsx's own comment on the identical gate.
    const raceStarted = raceStartRef?.current ?? true;
    const gatedControls = raceStarted ? controls : { ...controls, throttle: 0, brake: 1 };
    const lv = body.linvel();
    lastControlsRef.current = { throttle: gatedControls.throttle, yaw, lvx: lv.x, lvz: lv.z };
    // Auto gearbox (shift requests left false): the AI driver shifts by the
    // same rpm policy as the player's assist, never manually - the AI obeys
    // the exact same gear-modulated physics the player drives under.
    gearboxRef.current.auto = true;
    applyCarControls(
      controller,
      gatedControls,
      DEFAULT_ENGINE_FORCE,
      boostMultiplier,
      DEFAULT_BRAKE_FORCE,
      speedMs,
      true,
      { state: gearboxRef.current, shiftUp: false, shiftDown: false }
    );

    // Per-wheel surfaces, identical to Car.tsx and the headless harness (see
    // lib/tracks/surfaces.ts) - the AI must drive the same car the player
    // does, kerbs and gravel included, or the stability gate would be
    // testing something the game never runs.
    const surfaceSamples = wheelGroundPositions(body).map((wheel) =>
      sampleSurface(track, wheel.x, wheel.z)
    );
    applyKerbRideHeights(
      controller,
      surfaceSamples.map((sample) => sample.kerbRiseMeters)
    );
    applyLoadSensitiveFriction(
      controller,
      "high-downforce",
      1,
      wheelSurfaceGrips(surfaceSamples)
    );
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
    // Spin recovery (see resolveYawDampingTorque): the stabilizing torque
    // above only rights the car's TILT - a side contact leaves yaw spinning
    // freely, which is how a bumped AI ends up broadside with the car
    // behind driving into its flank. Damping only bites above the yaw rate
    // a car actually corners at, so normal cornering is untouched.
    const yawDamping = resolveYawDampingTorque(body.angvel().y);
    if (yawDamping !== 0) {
      body.applyTorqueImpulse({ x: 0, y: yawDamping * world.timestep, z: 0 }, true);
    }
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), "high-downforce");
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(body, "high-downforce", world.timestep);
    applySurfaceDragImpulse(body, meanSurfaceDrag(surfaceSamples), world.timestep);
    aiBufferRef.current.push(snapshotOf(body));
    if (trafficRef && trafficKey !== undefined) {
      trafficRef.current[trafficKey] = { x: pos.x, z: pos.z };
    }
    if (carPosesRef) {
      const rot = body.rotation();
      const lv = body.linvel();
      const pp = body.translation();
      carPosesRef.current[gridSlotIndex] = {
        position: [pp.x, pp.y, pp.z],
        rotation: [rot.x, rot.y, rot.z, rot.w],
        linvel: [lv.x, lv.y, lv.z],
      };
    }
  });

  useFrame(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const pos = chassisRef.current?.translation();
    const marker = minimapMarkerEls?.current?.[aiIndex];
    if (marker && pos) {
      marker.setAttribute("cx", pos.x.toFixed(1));
      marker.setAttribute("cy", pos.z.toFixed(1));
    }
    // Opponent half of the race audio snapshot (see
    // app/race/RaceAudioRig.tsx) - same rpm policy as the player's own
    // shift bar, so the two engines read as the same machinery. Only the
    // first rival drives the voice: mixing nineteen engines would be mud,
    // and positional panning needs exactly one source.
    if (audioRef && pos && aiIndex === 0) {
      const c = lastControlsRef.current;
      // Same forward/right convention as Car.tsx's own snapshot.
      const forwardMs = c.lvx * -Math.sin(c.yaw) + c.lvz * -Math.cos(c.yaw);
      const lateralMs = c.lvx * Math.cos(c.yaw) - c.lvz * Math.sin(c.yaw);
      audioRef.current.opponent = {
        rpm01: rpmTo01(rpmForGear(controller.currentVehicleSpeed(), gearboxRef.current.gear)),
        throttle01: Math.min(1, Math.max(0, c.throttle)),
        skid01: skidAmount01(lateralMs, forwardMs),
        x: pos.x,
        z: pos.z,
        yawRad: c.yaw,
      };
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
  });

  return (
    <RigidBody
      ref={chassisRef}
      colliders={false}
      position={[spawnX, spawnY, spawnZ]}
      rotation={[0, track.startPos.headingRad, 0]}
      linearDamping={LINEAR_DAMPING}
      angularDamping={ANGULAR_DAMPING}
      canSleep={false}
    >
      {/* colliders={false} + one explicit collider - see Car.tsx's own
          comment for why the auto-collider generation is unsafe here. */}
      <CuboidCollider args={CHASSIS_HALF_EXTENTS} mass={CHASSIS_MASS} />
      <F1CarBody bodyColor={bodyColor} steerRefs={steerRefs} spinRefs={spinRefs} />
    </RigidBody>
  );
}
