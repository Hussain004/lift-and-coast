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
  computeStabilizingTorque,
  createCarController,
  wheelGroundPositions,
  yawFromQuaternion,
} from "@/lib/physics/vehicle";
import { computeDownforceN } from "@/lib/physics/aero";
import { createEnergySystem } from "@/lib/physics/energy";
import {
  createGearboxState,
  engineTorqueMultiplier,
  rpmForGear,
  IDLE_RPM,
  REDLINE_RPM,
  SHIFT_UP_RPM,
} from "@/lib/physics/gearbox";
import { applyImpactDamage } from "@/lib/physics/damage";
import { TIRE_COMPOUNDS, computeCompoundGripMultiplier, type TireCompoundId } from "@/lib/physics/tireModel";
import { useDriveInput, type CameraMode } from "@/lib/input/useDriveInput";
import { createLapTimer, formatLapTime, LINE_HALF_WIDTH_METERS } from "@/lib/race/lapTimer";
import { DEFAULT_RACE_LAPS, retargetSessionUrl, type QualifyingFormat, type SessionMode } from "@/lib/race/sessionSetup";
import type { CarPose } from "@/lib/net/snapshots";
import { gridSlot } from "@/lib/race/grid";
import { createDeltaTracker, formatDelta } from "@/lib/race/deltaTimer";
import { createGhostRecorder } from "@/lib/race/ghostRecorder";
import { createSectorTimer, type SectorCrossing, type SectorColor } from "@/lib/race/sectorTimer";
import { computeRacePositions, buildTowerEntries, renderTowerHtml, towerOpponents, type RaceState } from "@/lib/race/racePosition";
import { polePosition, createQualifyingSession, playerGridSpot as gridSpotFromSession, recordQualiLap, tickQualifyingSession, type QualifyingTimes } from "@/lib/race/qualifying";
import { createRewindBuffer, REWIND_CAPACITY_SECONDS, snapshotOf, applySnapshot } from "@/lib/race/rewindBuffer";
import { loadPersonalBest, savePersonalBest } from "@/lib/persistence/personalBests";
import { recordChampionshipQuali, recordChampionshipResult } from "@/lib/persistence/championship";
import { pointsForPosition } from "@/lib/race/championship";
import {
  allWheelsOffTrack,
  checkTrackLimits,
  worldEdgeResetMeters,
} from "@/lib/tracks/trackLimits";
import {
  meanSurfaceDrag,
  sampleSurface,
  wheelSurfaceGrips,
} from "@/lib/tracks/surfaces";
import { computeSectorGates } from "@/lib/tracks/sectors";
import { computeMinimapTransform } from "@/lib/tracks/minimap";
import type { TrackData } from "@/lib/tracks/types";
import { F1CarBody } from "./F1CarBody";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import { impactGain01, rpmTo01, skidAmount01 } from "@/lib/audio/raceAudio";
import { FLAP_OPEN_RAD, stepFlapAngle } from "@/lib/race/carBody";

const SECTOR_COUNT = 3;
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
const RACE_TRACK_LIMIT_PENALTY_SECONDS = 5;
const PENALTY_TOAST_DURATION_SECONDS = 2.5;
const SECTOR_COLOR_HEX: Record<SectorColor, string> = {
  purple: "#b967ff",
  green: "#39ff88",
  yellow: "#ffd23f",
};

export function Car({
  chassisRef,
  visualRef,
  cameraModeRef,
  racingLineVisibleRef,
  speedRef,
  lapRef,
  deltaRef,
  sectorsRef,
  trackLimitRef,
  energyRef,
  aeroModeRef,
  tireRef,
  assistsRef,
  damageRef,
  gearRef,
  rpmRef,
  minimapGroupRef,
  minimapMarkerRef,
  positionRef,
  raceResultRef,
  towerRef,
  raceRef,
  raceLaps = DEFAULT_RACE_LAPS,
  champRound = null,
  sessionMode = "race",
  qualiFormat = "timed",
  playerGridSpot = null,
  playerCode = "YOU",
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
  qualifyingRef,
  qualifyingDisplayRef,
  penaltyToastRef,
  track,
  bodyColor = "#39ff88",
  audioRef,
}: {
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
  speedRef?: React.RefObject<HTMLDivElement | null>;
  lapRef?: React.RefObject<HTMLDivElement | null>;
  deltaRef?: React.RefObject<HTMLDivElement | null>;
  sectorsRef?: React.RefObject<HTMLDivElement | null>;
  trackLimitRef?: React.RefObject<HTMLDivElement | null>;
  energyRef?: React.RefObject<HTMLDivElement | null>;
  aeroModeRef?: React.RefObject<HTMLDivElement | null>;
  tireRef?: React.RefObject<HTMLDivElement | null>;
  assistsRef?: React.RefObject<HTMLDivElement | null>;
  damageRef?: React.RefObject<HTMLDivElement | null>;
  gearRef?: React.RefObject<HTMLDivElement | null>;
  rpmRef?: React.RefObject<HTMLDivElement | null>;
  minimapGroupRef?: React.RefObject<SVGGElement | null>;
  minimapMarkerRef?: React.RefObject<SVGPolygonElement | null>;
  positionRef?: React.RefObject<HTMLDivElement | null>;
  raceResultRef?: React.RefObject<HTMLDivElement | null>;
  /** F1 timing tower body (see page.tsx) - Car rewrites its rows ~10Hz. */
  towerRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * Shared with AICar.tsx (created in Scene.tsx) - each car writes its own
   * lap/progress into its own slot of this plain mutable object every
   * physics tick, so this component can rank the full field for a live
   * position without either car needing a ref to the other's internals.
   */
  raceRef?: React.RefObject<RaceState>;
  /** Quick Race lap count - see page.tsx's ?laps= URL param. */
  raceLaps?: number;
  /**
   * Championship round index from page.tsx's ?champ= param, or null for a
   * one-off race. When set, finishing writes the player's position into the
   * active season (see recordChampionshipResult).
   */
  champRound?: number | null;
  /** Session kind from ?mode= (default race) - practice is solo free
   * driving, qualifying sets a grid, race is wheel-to-wheel. */
  sessionMode?: SessionMode;
  /** Qualifying format from ?qformat= (default timed). */
  qualiFormat?: QualifyingFormat;
  /**
   * The player's grid spot from ?grid= (1-based), or null for a staggered
   * start from pole. Every other slot goes to the rivals in order.
   */
  playerGridSpot?: number | null;
  /** The player's FIA code for the tower (see page.tsx's roster pick). */
  playerCode?: string;
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
  rivals?: { code: string; color: string }[];
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
  /** Playable Qualifying (see lib/race/qualifying.ts) - shared with AICar.tsx. */
  qualifyingRef?: React.RefObject<QualifyingTimes>;
  qualifyingDisplayRef?: React.RefObject<HTMLDivElement | null>;
  /** Live "+Ns PENALTY" flash for the race-mode track-limit penalty below. */
  penaltyToastRef?: React.RefObject<HTMLDivElement | null>;
  track: TrackData;
  /** Garage pick (see lib/race/roster.ts) - the team's primary livery. */
  bodyColor?: string;
  /** Shared with the race audio rig (see app/race/RaceAudioRig.tsx) - this
   * car fills in the player half every render frame from live telemetry. */
  audioRef?: React.RefObject<AudioSnapshot>;
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
  // Rear-wing flap pivot (see app/race/F1CarBody.tsx) - rotated open in
  // low-drag mode, like the real active-aero flap.
  const flapRef = useRef<THREE.Group | null>(null);
  const { world, rapier } = useRapier();
  const { update, input, aeroMode, cameraMode, tireCompound, tractionControlEnabled, absEnabled, racingLineVisible, autoGear, gamepadConnected } =
    useDriveInput(cameraModeRef, racingLineVisibleRef);
  // Plan section 5 depth feature 4 (manual gears): one persistent gearbox
  // per car. `auto` follows the autoGear toggle (synced each physics tick
  // below) so the HUD and drive model always agree with the assist state.
  const gearboxRef = useRef(createGearboxState(true));
  const lapTimerRef = useRef(
    createLapTimer({
      startPos,
      lineHalfWidth: LINE_HALF_WIDTH_METERS,
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
  // Tower repaint throttle: the rows rebuild at ~10Hz (every 6th physics
  // tick), not 60Hz - order and gaps don't move faster than that, and
  // innerHTML churn every frame would trash layout for nothing.
  const towerFrameRef = useRef(0);
  // Race clock timestamp (not lap-relative currentLapSeconds, which resets
  // every lap and could strand the toast if a penalty lands late in a lap)
  // to hide the penalty toast at.
  const penaltyToastHideAtRef = useRef<number | null>(null);
  const qualifyingDisplayedRef = useRef(false);
  const bestLapRef = useRef<number | null>(null);
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
  const sectorTimerRef = useRef(createSectorTimer(computeSectorGates(track, SECTOR_COUNT)));
  const sectorResultsRef = useRef<(SectorCrossing | null)[]>(
    new Array(SECTOR_COUNT).fill(null)
  );
  const ghostRecorderRef = useRef(createGhostRecorder());
  // Ghost replay (see F1CarBody's ghost prop): the reference lap driven
  // back as a translucent silhouette of the real car, posed every frame
  // from the recorder - wheels parked, since a replay needs no steering.
  const ghostGroupRef = useRef<THREE.Group>(null);
  const ghostSteerRefs = useRef<(THREE.Group | null)[]>([]);
  const ghostSpinRefs = useRef<(THREE.Group | null)[]>([]);
  // Distance driven (odometer-style, direction-independent) since the
  // current compound was fitted - see computeCompoundGripMultiplier in
  // tireModel.ts. Not lap-scoped: real tire wear accumulates across a
  // whole stint, not per lap, and this project has no pit-stop system yet
  // to force a reset - switching compounds (the 1/2/3 keys, owned by
  // useDriveInput) is the only reset trigger, standing in for fitting a
  // fresh set. Deliberately NOT touched by rewind or the off-track
  // teleport reset - both roll back POSITION/TIME, but the tires
  // physically experienced those meters regardless, same as a real
  // rewind not un-scrubbing tire wear. Pressing the SAME compound's key
  // again while already on it is a no-op (change-detected below, not
  // event-detected) - there's no way to "re-fit an identical fresh set"
  // without switching away and back, a known, minor limitation.
  const tireWornMetersRef = useRef(0);
  // Last compound seen, to detect a change made via the 1/2/3 keys (owned
  // by useDriveInput, see tireCompound above) and reset wear on switch -
  // the wear tracking itself lives here rather than in useDriveInput
  // since it needs per-frame speed/distance data that hook doesn't have.
  const prevTireCompoundRef = useRef<TireCompoundId>(tireCompound.current);
  // Grip lost to impact damage (1 = undamaged) - see applyImpactDamage's own
  // comment. Reset on the same "fresh attempt" triggers as the lap-scoped
  // state below: a new lap starting, or the off-track/world-edge teleport
  // reset snapping the car back to the start line.
  const damageGripMultiplierRef = useRef(1);
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
  const wasRewindingRef = useRef(false);
  const isRewindingRef = useRef(false);

  const energySystemRef = useRef(createEnergySystem());
  const batteryFractionRef = useRef(1);
  const startRotationRef = useRef(
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, startPos.headingRad, 0))
  );

  useEffect(() => {
    // A full page reload rather than resetting each of this component's
    // (and AICar's, and the grid-start countdown's) many lap/race-scoped
    // refs by hand - this project has no menu/results state machine to
    // return to yet (see the finish-banner comment below), and a manual
    // reset would need every one of those refs kept in perfect sync
    // forever as new race-scoped state gets added. Reloading the exact
    // current URL re-mounts everything from scratch (Rapier world
    // included) and keeps any ?laps= param for free.
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Enter" && raceFinishedRef.current) {
        window.location.reload();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, []);

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

        const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
        if (torque[0] || torque[1] || torque[2]) {
          body.applyTorqueImpulse(
            { x: torque[0] * timestep, y: torque[1] * timestep, z: torque[2] * timestep },
            true
          );
        }
        const downforceN = computeDownforceN(controller.currentVehicleSpeed());
        body.applyImpulse({ x: 0, y: -downforceN * timestep, z: 0 }, true);
        applyDragImpulse(body, aeroMode.current, timestep);

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

  useBeforePhysicsStep(() => {
    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
    const driveInput = update(world.timestep);
    isRewindingRef.current = driveInput.rewind;
    if (sharedRewindActiveRef) sharedRewindActiveRef.current = driveInput.rewind;

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
    // Reused below for the surface grip penalty too, instead of a second
    // brute-force nearest-centerline-point scan for the same position.
    const limitStatus = checkTrackLimits(track, pos.x, pos.z);
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
      // Clear rewind state too - otherwise a reset that lands mid-rewind
      // (holding R while 300m out, the exact situation a stranded player
      // reaches for) leaves wasRewindingRef true, and the next tick's
      // resumeFrom() teleports the car straight back out to the stale
      // pre-reset snapshot.
      wasRewindingRef.current = false;
      rewindCursorRef.current = 0;
      lapHadDiscontinuityRef.current = true;
      // Otherwise nextGateIndex would still point at whatever gate was
      // being approached before the teleport - the car driving from the
      // start line would silently miss gate 0 and later register a
      // garbage split spanning the teleport (see sectorTimer.reset).
      sectorTimerRef.current.reset();
      damageGripMultiplierRef.current = 1;
      return;
    }

    if (driveInput.rewind) {
      lapHadDiscontinuityRef.current = true;
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
      if (lapInvalidAtSecondsRef.current === null || rolledBackTo <= lapInvalidAtSecondsRef.current) {
        lapInvalidRef.current = false;
        lapInvalidAtSecondsRef.current = null;
      }
      rewindCursorRef.current = 0;
      wasRewindingRef.current = false;
    }

    // Grid start: throttle and Push-to-Pass only, so the car can still
    // brake/steer to hold its spot before the lights go out, but can't
    // jump the start - or drain the battery deploying into a locked
    // driveline (holding Shift through the countdown would otherwise
    // arrive at turn 1 with an empty battery and no boost).
    const raceStarted = raceStartRef?.current ?? true;
    const gatedDriveInput = raceStarted
      ? driveInput
      : { ...driveInput, throttle: 0, deploy: false };

    // Guest input upload reads the gated inputs actually applied (see
    // playerInputRef) - what the car does, not what the keys say.
    if (playerInputRef) {
      playerInputRef.current = {
        throttle: gatedDriveInput.throttle,
        brake: gatedDriveInput.brake,
        steer: gatedDriveInput.steer,
      };
    }

    const energyStatus = energySystemRef.current.update(
      { brakeAmount: gatedDriveInput.brake, deployRequested: gatedDriveInput.deploy },
      world.timestep
    );
    batteryFractionRef.current = energyStatus.batteryFraction;

    // Sync the gearbox's assist mode to the live toggle (useDriveInput
    // owns the G key, Car.tsx owns the gear state) before the drive model
    // and HUD both read it this tick.
    gearboxRef.current.auto = autoGear.current;
    applyCarControls(
      controller,
      gatedDriveInput,
      DEFAULT_ENGINE_FORCE,
      energyStatus.engineForceMultiplier,
      DEFAULT_BRAKE_FORCE,
      controller.currentVehicleSpeed(),
      tractionControlEnabled.current,
      {
        state: gearboxRef.current,
        shiftUp: gatedDriveInput.shiftUp,
        shiftDown: gatedDriveInput.shiftDown,
      }
    );

    // A fresh set is fitted the instant the player switches compounds
    // (1/2/3 keys, owned by useDriveInput) - see tireWornMetersRef's own
    // comment for why that's the only reset trigger this project has
    // right now.
    if (tireCompound.current !== prevTireCompoundRef.current) {
      prevTireCompoundRef.current = tireCompound.current;
      tireWornMetersRef.current = 0;
    }
    // Odometer-style accumulation using this step's pre-update speed - a
    // one-step lag against the exact instantaneous speed, immaterial at
    // 60Hz for a quantity that only meaningfully changes over many meters.
    tireWornMetersRef.current += Math.abs(controller.currentVehicleSpeed()) * world.timestep;
    const compoundGripMultiplier = computeCompoundGripMultiplier(
      TIRE_COMPOUNDS[tireCompound.current],
      tireWornMetersRef.current
    );
    // Per-wheel surfaces (plan section 4 point 7 / section 5 depth feature 6),
    // replacing the old single chassis-center distanceFromEdgeMeters
    // approximation: each wheel is classified separately, so clipping an apex
    // kerb or dropping one wheel into a gravel trap acts on that wheel rather
    // than being averaged across the whole car. Two wheels off is a very
    // different car from four, which is the skill this exists to create.
    const surfaceSamples = wheelGroundPositions(body).map((wheel) =>
      sampleSurface(track, wheel.x, wheel.z)
    );
    applyKerbRideHeights(
      controller,
      surfaceSamples.map((sample) => sample.kerbRiseMeters)
    );
    applyLoadSensitiveFriction(
      controller,
      aeroMode.current,
      compoundGripMultiplier,
      wheelSurfaceGrips(surfaceSamples),
      damageGripMultiplierRef.current
    );
    controller.updateVehicle(world.timestep);

    const torque = computeStabilizingTorque(body.rotation(), DEFAULT_STABILIZE_STRENGTH);
    if (torque[0] || torque[1] || torque[2]) {
      body.applyTorqueImpulse(
        { x: torque[0] * world.timestep, y: torque[1] * world.timestep, z: torque[2] * world.timestep },
        true
      );
    }
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), aeroMode.current);
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(body, aeroMode.current, world.timestep);
    // Grass/gravel drag (plan section 4 point 7), on top of the aero drag
    // above - a wide moment costs time, and a gravel trap takes the car off
    // the driver's hands entirely rather than merely slowing it.
    applySurfaceDragImpulse(body, meanSurfaceDrag(surfaceSamples), world.timestep);

    rewindBufferRef.current.push(snapshotOf(body));
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

  function renderSectors() {
    if (!sectorsRef?.current) return;
    sectorsRef.current.innerHTML = sectorResultsRef.current
      .map((s, i) =>
        s
          ? `<span style="color:${SECTOR_COLOR_HEX[s.color]}">S${i + 1} ${s.sectorSeconds.toFixed(3)}</span>`
          : `<span>S${i + 1} --.---</span>`
      )
      .join("");
  }

  useFrame((_, dt) => {
    // Hide the chassis mesh in cockpit mode - otherwise the camera (see
    // ChaseCamera in Scene.tsx) sits inside a solid box and renders its
    // inside faces. Cheaper and more robust than offsetting the camera
    // just ahead of the chassis, which would still clip through on a hard
    // pitch/roll. Runs before the controller/body guard below so a
    // transient null (a remount, a track change) while in cockpit mode
    // can't leave the car permanently invisible with nothing left to
    // restore it.
    if (visualRef?.current) {
      visualRef.current.visible = cameraMode.current !== "cockpit";
    }

    const controller = controllerRef.current;
    const body = chassisRef.current;
    if (!controller || !body) return;
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
    if (speedRef?.current) {
      const kmh = Math.abs(controller.currentVehicleSpeed()) * 3.6;
      speedRef.current.textContent = `${Math.round(kmh)} km/h`;
    }
    if (energyRef?.current) {
      energyRef.current.style.width = `${(batteryFractionRef.current * 100).toFixed(1)}%`;
    }
    if (aeroModeRef?.current) {
      aeroModeRef.current.textContent =
        aeroMode.current === "low-drag" ? "LOW DRAG" : "HIGH DOWNFORCE";
    }
    // Active-aero flap (plan section 5): the rear-wing top element rotates
    // open in low-drag mode and shut otherwise, rate-limited like a real
    // actuator rather than snapping.
    if (flapRef.current) {
      const target = aeroMode.current === "low-drag" ? FLAP_OPEN_RAD : 0;
      flapRef.current.rotation.x = stepFlapAngle(flapRef.current.rotation.x, target, dt);
    }
    if (tireRef?.current) {
      const gripPercent = Math.round(
        computeCompoundGripMultiplier(TIRE_COMPOUNDS[tireCompound.current], tireWornMetersRef.current) *
          100
      );
      tireRef.current.textContent = `${tireCompound.current.toUpperCase()} ${gripPercent}%`;
    }
    if (assistsRef?.current) {
      assistsRef.current.textContent =
        `TC ${tractionControlEnabled.current ? "ON" : "OFF"}` +
        `  ABS ${absEnabled.current ? "ON" : "OFF"}` +
        `  GEARS ${autoGear.current ? "AUTO" : "M"}` +
        `  PAD ${gamepadConnected.current ? "ON" : "OFF"}` +
        (racingLineVisible.current ? "" : "  LINE OFF");
    }
    // Manual gears HUD (plan section 13): the current gear up top, and
    // below it an rpm bar anchored at idle that redlines-turns-red at the
    // shift point - the "shift light" that teaches the auto-assist's
    // optimal band (the skill manual drivers learn by feel).
    if (gearRef?.current || rpmRef?.current) {
      const rpm = rpmForGear(controller.currentVehicleSpeed(), gearboxRef.current.gear);
      if (gearRef?.current) {
        gearRef.current.textContent = `${gearboxRef.current.gear}`;
      }
      if (rpmRef?.current) {
        const fraction = Math.min(1, Math.max(0, (rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM)));
        rpmRef.current.style.width = `${(fraction * 100).toFixed(1)}%`;
        rpmRef.current.style.background =
          rpm >= SHIFT_UP_RPM ? "#ff3b3b" : engineTorqueMultiplier(rpm) >= 0.99 ? "#39ff88" : "#ffd23f";
      }
    }
    if (damageRef?.current) {
      const damagePercent = Math.round(damageGripMultiplierRef.current * 100);
      damageRef.current.textContent = damagePercent < 100 ? `DAMAGE ${damagePercent}%` : "";
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
      audioRef.current.player = {
        rpm01: rpmTo01(rpmForGear(controller.currentVehicleSpeed(), gearboxRef.current.gear)),
        throttle01: Math.min(1, Math.max(0, input.current.throttle)),
        skid01: skidAmount01(lateralMs, forwardMs),
        x: p.x,
        z: p.z,
        yawRad: yaw,
      };
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
    const status = checkTrackLimits(track, t.x, t.z);
    const lap = lapTimerRef.current.update({ x: t.x, z: t.z }, dt);

    if (!raceFinishedRef.current) {
      raceElapsedSecondsRef.current += dt;
    }
    if (raceRef?.current) {
      const yawNow = yawFromQuaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
      raceRef.current.player = {
        lapCount: lap.lapCount,
        progressMeters: status.progressMeters,
        speedMs: computeSignedForwardSpeed(body.linvel(), yawNow),
      };
      const progresses = [raceRef.current.player, ...raceRef.current.opponents];
      const positions = computeRacePositions(progresses, track.lengthMeters);
      if (positionRef?.current && !raceFinishedRef.current) {
        positionRef.current.textContent = `P${positions[0]}`;
      }
      // F1 timing tower (see buildTowerEntries/renderTowerHtml): rebuilt
      // at ~10Hz, not per tick - order and gaps never move faster.
      towerFrameRef.current += 1;
      if (towerRef?.current && towerFrameRef.current % 6 === 0) {
        // TEMP DEBUG (removed after diagnosis)
        if (towerFrameRef.current % 600 === 0) {
          const opp = raceRef.current.opponents.map(
            (o, k) => `${k}:${o.lapCount}x${Math.round(o.progressMeters)}`
          );
          console.log(
            `[towerdbg] t=${raceElapsedSecondsRef.current.toFixed(1)} player=${raceRef.current.player.lapCount}x${Math.round(raceRef.current.player.progressMeters)} opp=[${opp.join(" ")}]`
          );
        }
        const entries = buildTowerEntries(
          { code: playerCode, color: bodyColor, progress: raceRef.current.player },
          towerOpponents(rivals, raceRef.current.opponents),
          track.lengthMeters
        );
        towerRef.current.innerHTML = renderTowerHtml(entries);
      }
    }

    const eligible = !lapHadDiscontinuityRef.current && !lapInvalidRef.current;

    // Playable Qualifying (plan section 7): best valid lap per car,
    // informing the overlay below in race mode and the grid in qualifying
    // sessions. Valid means the lap's own `eligible` flag (clean +
    // continuous, same standard as the delta/ghost reference) - symmetric
    // with AICar.tsx's own best-valid recording. Checked every frame (not
    // just inside the crossedFinishLine block below) since the cars'
    // laps usually finish on different frames.
    if (qualifyingDisplayRef?.current && !qualifyingDisplayedRef.current) {
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
        qualifyingDisplayRef.current.textContent =
          `QUALIFYING - YOU ${formatLapTime(playerTime)}  ${rivalCode} ${formatLapTime(rivalTime)}  -  ` +
          `${onPole} ON POLE`;
      }
    }

    if (lap.crossedFinishLine && lap.lastLapSeconds !== null) {
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
      }
      // ponytail: the race "ends" here as a HUD banner only - driving,
      // physics, and the AI keep going, and there's no in-race results/menu
      // screen to return to (plan section 8's menu state machine doesn't
      // exist yet). Also doesn't account for the AI finishing its own
      // RACE_LAPS first - the banner only triggers off the player's own
      // finish-line crossing. A championship round is still scored correctly
      // (the finish order is settled the moment the player crosses, see
      // finalPosition below); a dedicated results screen would just show it
      // in place. Upgrade once session setup/results screens exist.
      if (sessionMode === "race" && !raceFinishedRef.current && lap.lapCount >= raceLaps && raceResultRef?.current) {
        raceFinishedRef.current = true;
        // raceElapsedSecondsRef stops advancing once raceFinishedRef flips
        // (see the guard above it), so the penalty toast's hide-at clock
        // would otherwise freeze too - clear it here rather than leave it
        // stuck on screen next to the finish banner until reload.
        if (penaltyToastRef?.current) {
          penaltyToastRef.current.textContent = "";
        }
        penaltyToastHideAtRef.current = null;
        const finalPositions = raceRef?.current
          ? computeRacePositions(
              [raceRef.current.player, ...raceRef.current.opponents],
              track.lengthMeters
            )
          : [1];
        const finalPosition = finalPositions[0];
        // Net rooms: the host's broadcast order is the result (see
        // netResultRef) - every guest shows the same board, and nobody
        // scores a championship round from an exhibition. Slot-keyed, so
        // shared driver codes can't collide.
        const netPositions = netActive ? netResultRef?.current?.positions ?? null : null;
        const shownPosition = netPositions?.[String(netSlot)] ?? finalPosition;
        let championshipSuffix = "";
        if (champRound !== null && !netActive) {
          championshipSuffix =
            `  //  ROUND ${champRound + 1}: P${finalPosition} (+${pointsForPosition(finalPosition)} PTS)`;
          // Fire-and-forget, same as the personal-best write below: the
          // standings panel reads this back when the player returns home.
          recordChampionshipResult(champRound, finalPosition).catch(() => {});
        }
        raceResultRef.current.textContent =
          `P${shownPosition} - ${raceLaps}-LAP RACE FINISHED - ${formatLapTime(raceElapsedSecondsRef.current)}` +
          championshipSuffix +
          `  //  PRESS ENTER TO RESTART`;
      }
      if (sessionMode === "practice" && !raceFinishedRef.current && lap.lapCount >= raceLaps && raceResultRef?.current) {
        // Solo session: driving on after the count is fine, but the banner
        // fires once with the session's best and a way back. Runs before
        // the wasNewBest bookkeeping below, so fold this lap in by hand.
        raceFinishedRef.current = true;
        const candidates = [bestLapRef.current, eligible ? lap.lastLapSeconds : null].filter(
          (v): v is number => v !== null
        );
        const sessionBest = candidates.length > 0 ? Math.min(...candidates) : null;
        raceResultRef.current.innerHTML =
          `PRACTICE COMPLETE - ${raceLaps} LAPS - BEST ${formatLapTime(sessionBest)}` +
          `  //  <a href="${window.location.pathname}${window.location.search}">DRIVE AGAIN</a>  //  <a href="/">MENU</a>`;
      }
      const wasNewBest =
        eligible && (bestLapRef.current === null || lap.lastLapSeconds < bestLapRef.current);
      if (wasNewBest) {
        bestLapRef.current = lap.lastLapSeconds;
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
      lapInvalidRef.current = false;
      lapInvalidAtSecondsRef.current = null;
      damageGripMultiplierRef.current = 1;
    }

    const sectorCrossing = sectorTimerRef.current.update(t.x, t.z, lap.currentLapSeconds, eligible);
    if (sectorCrossing) {
      sectorResultsRef.current[sectorCrossing.sectorIndex] = sectorCrossing;
      renderSectors();
    }

    // The real track-limits rule (plan section 5, depth feature 7): the
    // HUD warning fires on the same all-four-wheels-off rule that
    // invalidates the lap (see allWheelsOffTrack) - a wheel still on the
    // asphalt keeps the car legal, same as real regulations, so running
    // wide with grip still on one side no longer flashes a warning.
    const wheelWorldPositions = wheelGroundPositions(body);
    const allFourWheelsOff = allWheelsOffTrack(track, wheelWorldPositions);
    if (allFourWheelsOff) {
      // Only record the timestamp on the first violation this lap - a
      // rewind must reach back to the START of the infraction to undo it,
      // not just its most recent moment.
      if (!lapInvalidRef.current) {
        lapInvalidAtSecondsRef.current = lap.currentLapSeconds;
        // ponytail: applied once here and never refunded, even if a later
        // rewind reaches back far enough to clear lapInvalidRef (see the
        // rewind-resume block above) - undoing the mistake stops it from
        // costing another invalidated lap, but the race-clock penalty
        // already happened. Revisit if that gap turns out to matter in
        // practice.
        if (!raceFinishedRef.current) {
          raceElapsedSecondsRef.current += RACE_TRACK_LIMIT_PENALTY_SECONDS;
          if (penaltyToastRef?.current) {
            penaltyToastRef.current.textContent = `+${RACE_TRACK_LIMIT_PENALTY_SECONDS}s PENALTY`;
          }
          penaltyToastHideAtRef.current = raceElapsedSecondsRef.current + PENALTY_TOAST_DURATION_SECONDS;
        }
      }
      lapInvalidRef.current = true;
    }

    if (lapRef?.current) {
      if (sessionMode === "qualifying" && qualiFormat === "timed") {
        const remaining = qualiSessionRef.current.timeLeftSeconds;
        const mm = Math.floor(remaining / 60);
        const ss = Math.floor(remaining % 60)
          .toString()
          .padStart(2, "0");
        lapRef.current.textContent =
          `QUAL ${mm}:${ss}  BEST ${formatLapTime(bestLapRef.current)}` +
          (lapInvalidRef.current ? "  INVALID" : "");
      } else if (sessionMode === "qualifying") {
        lapRef.current.textContent =
          `QUAL SHOT  LAP ${lap.lapCount + 1}  BEST ${formatLapTime(bestLapRef.current)}` +
          (lapInvalidRef.current ? "  INVALID" : "");
      } else if (sessionMode === "practice") {
        lapRef.current.textContent =
          `PRAC ${Math.min(lap.lapCount + 1, raceLaps)}/${raceLaps}  BEST ${formatLapTime(bestLapRef.current)}` +
          (lapInvalidRef.current ? "  INVALID" : "");
      } else {
        lapRef.current.textContent =
          `LAP ${lap.lapCount + 1}  ${formatLapTime(lap.currentLapSeconds)}` +
          `  BEST ${formatLapTime(bestLapRef.current)}` +
          (lapInvalidRef.current ? "  INVALID" : "");
      }
    }

    if (sessionMode === "qualifying" && !qualiFinishedRef.current) {
      if (qualiFormat === "timed") {
        qualiSessionRef.current = tickQualifyingSession(qualiSessionRef.current, dt);
      }
      if (qualiSessionRef.current.finished && raceResultRef?.current) {
        qualiFinishedRef.current = true;
        // Rivals' bests arrive through the shared times (see AICar.tsx) -
        // whatever each has set when the player's session ends counts. The
        // session machine only ever records the player's own laps, so the
        // merge is a padded copy of the shared board, not a real merge.
        const sharedBests = qualifyingRef?.current?.opponents ?? [];
        const mergedBest = {
          player: qualiSessionRef.current.best.player,
          opponents: rivals.map((_, k) => sharedBests[k] ?? null),
        };
        const spot = gridSpotFromSession({ ...qualiSessionRef.current, best: mergedBest });
        if (champRound !== null) {
          recordChampionshipQuali(champRound, spot).catch(() => {});
        }
        const raceHref = retargetSessionUrl(window.location.search, "race", spot);
        // Fastest rival lap for the summary line (best of whoever set one).
        let bestRival: number | null = null;
        let bestRivalCode = "RIVAL";
        mergedBest.opponents.forEach((time, k) => {
          if (time !== null && (bestRival === null || time < bestRival)) {
            bestRival = time;
            bestRivalCode = rivals[k]?.code ?? "RIVAL";
          }
        });
        const resultLine =
          `QUALIFYING COMPLETE - YOU ${formatLapTime(mergedBest.player)}` +
          `  ${bestRivalCode} ${formatLapTime(bestRival)}  -  YOU START P${spot}`;
        raceResultRef.current.innerHTML =
          champRound !== null
            ? `${resultLine}  //  <a href="${raceHref}">RACE ROUND ${champRound + 1}</a>  //  <a href="/">MENU</a>`
            : `${resultLine}  //  <a href="${raceHref}">RACE FROM P${spot}</a>  //  <a href="/">MENU</a>`;
      }
    }

    const delta = deltaTrackerRef.current.recordSample(status.progressMeters, lap.currentLapSeconds);
    if (deltaRef?.current) {
      deltaRef.current.textContent = formatDelta(delta);
      deltaRef.current.dataset.sign = delta === null || delta === 0 ? "" : delta > 0 ? "behind" : "ahead";
    }

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

    if (trackLimitRef?.current) {
      trackLimitRef.current.textContent = allFourWheelsOff ? "TRACK LIMITS" : "";
    }

    if (
      penaltyToastRef?.current &&
      penaltyToastHideAtRef.current !== null &&
      raceElapsedSecondsRef.current >= penaltyToastHideAtRef.current
    ) {
      penaltyToastRef.current.textContent = "";
      penaltyToastHideAtRef.current = null;
    }

    if (minimapGroupRef?.current) {
      const yaw = yawFromQuaternion(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
      minimapGroupRef.current.setAttribute("transform", computeMinimapTransform(t.x, t.z, yaw));
    }
    if (minimapMarkerRef?.current) {
      minimapMarkerRef.current.setAttribute("fill", allFourWheelsOff ? "#ff3b3b" : bodyColor);
    }
  });

  return (
    <>
      <group ref={ghostGroupRef} visible={false}>
        <F1CarBody bodyColor={bodyColor} steerRefs={ghostSteerRefs} spinRefs={ghostSpinRefs} ghost />
      </group>
      <RigidBody
        ref={chassisRef}
        colliders={false}
        position={[gridSpot.x, gridSpot.y, gridSpot.z]}
        rotation={[0, startPos.headingRad, 0]}
        linearDamping={LINEAR_DAMPING}
        angularDamping={ANGULAR_DAMPING}
        canSleep={false}
        onContactForce={(payload: ContactForcePayload) => {
          damageGripMultiplierRef.current = applyImpactDamage(
            damageGripMultiplierRef.current,
            payload.totalForceMagnitude
          );
          // Thump for the race audio rig (see app/race/RaceAudioRig.tsx) -
          // same force scale as the damage model, so only chassis-scale hits
          // speak.
          if (audioRef) {
            const strength = impactGain01(payload.totalForceMagnitude);
            if (strength > 0) {
              audioRef.current.impact = { strength01: strength, atMs: performance.now() };
            }
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
          <F1CarBody bodyColor={bodyColor} steerRefs={steerRefs} spinRefs={spinRefs} flapRef={flapRef} />
        </group>
      </RigidBody>
    </>
  );
}
