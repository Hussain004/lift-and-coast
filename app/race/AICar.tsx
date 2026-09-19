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
import { computeRacingLine } from "@/lib/tracks/racingLine";
import { computeAIControls } from "@/lib/ai/pathFollower";
import { createLapTimer, LINE_HALF_WIDTH_METERS } from "@/lib/race/lapTimer";
import { gridSpawn } from "@/lib/race/grid";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import { rpmTo01, skidAmount01 } from "@/lib/audio/raceAudio";
import type { RaceState } from "@/lib/race/racePosition";
import type { QualifyingTimes } from "@/lib/race/qualifying";
import type { TrackData } from "@/lib/tracks/types";

/**
 * A single AI opponent (plan section 6): follows the same ideal-line
 * approximation drawn for the player (lib/tracks/racingLine.ts) using
 * pure-pursuit steering and curvature-derived speed targets
 * (lib/ai/pathFollower.ts), running the identical vehicle rig as the
 * player's own car (Car.tsx) so it's bound by the same physics. No
 * racecraft, no opponent awareness, no difficulty tiers - groundwork for
 * a race weekend, not one.
 *
 * Deliberately owns its own chassis/visual/controller refs rather than
 * sharing anything with Scene.tsx's player refs - ChaseCamera follows
 * Scene.tsx's visualRef, and this car must never become that target.
 *
 * Does track its own lap count now (plan section 7's Quick Race), writing
 * into the shared raceRef so Car.tsx can compute a live P1/P2 without
 * either car needing a ref into the other's internals. Also writes its own
 * world position into minimapMarkerRef each frame so it shows up on the
 * player's minimap (a plain SVG circle, not the rotating egocentric
 * marker the player gets - see page.tsx). In qualifying sessions its best
 * valid lap feeds the shared qualifying times (see the validity latch
 * below) so the grid reflects clean laps only.
 */
export function AICar({
  track,
  raceRef,
  minimapMarkerRef,
  raceStartRef,
  qualifyingRef,
  playerGridSpot = null,
  bodyColor = "#ff5a3c",
  audioRef,
}: {
  track: TrackData;
  raceRef?: React.RefObject<RaceState>;
  minimapMarkerRef?: React.RefObject<SVGCircleElement | null>;
  /** Grid start (Scene.tsx) - throttle is locked out while false. */
  raceStartRef?: React.RefObject<boolean>;
  /** Playable Qualifying (see lib/race/qualifying.ts) - shared with Car.tsx. */
  qualifyingRef?: React.RefObject<QualifyingTimes>;
  /**
   * The PLAYER's grid spot (see Scene.tsx) - the AI takes the other one.
   * Null keeps the old equal standing start.
   */
  playerGridSpot?: 1 | 2 | null;
  /** Garage pick (see lib/race/roster.ts) - the teammate-opponent's secondary livery. */
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
      startsBehindLine: gridSpawn(track, playerGridSpot, false).startsBehindLine,
    })
  );
  // Validity latch for the shared qualifying times (mirrors the player's
  // lapInvalidRef in Car.tsx, minus rewinds - the AI has no undo): any
  // all-four-off moment taints the current lap, and the latch resets on
  // every crossing so each lap is judged on its own driving.
  const aiLapInvalidRef = useRef(false);

  const racingLine = useMemo(() => computeRacingLine(track), [track]);

  const { spawnX, spawnZ, spawnQuat } = useMemo(() => {
    const grid = gridSpawn(track, playerGridSpot, false);
    const yaw = track.startPos.headingRad;
    return {
      spawnX: grid.x,
      spawnZ: grid.z,
      spawnQuat: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)),
    };
  }, [track, playerGridSpot]);

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

    const pos = body.translation();
    const limitStatus = checkTrackLimits(track, pos.x, pos.z);
    // Same safety backstop as the player's car (Car.tsx) - without it, a
    // path-follower bug or a bad launch could leave the AI stuck off-course
    // or run it past the finite ground field's edge for the rest of the
    // session with nothing to recover it.
    if (
      limitStatus.distanceFromEdgeMeters > OFF_TRACK_RESET_METERS ||
      Math.hypot(pos.x, pos.z) > worldEdgeResetMeters(track)
    ) {
      body.setTranslation({ x: spawnX, y: 1, z: spawnZ }, true);
      body.setRotation({ x: spawnQuat.x, y: spawnQuat.y, z: spawnQuat.z, w: spawnQuat.w }, true);
      body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      return;
    }

    // Grid start (Scene.tsx) - same reasoning as Car.tsx's identical guard:
    // the lap timer accumulates currentLapSeconds every tick regardless of
    // whether the car is actually moving, so it must not run during the
    // countdown (the AI is held stationary by the throttle gate below too).
    if (raceStartRef?.current ?? true) {
      const lap = lapTimerRef.current.update({ x: pos.x, z: pos.z }, world.timestep);
      if (raceRef?.current) {
        raceRef.current.ai = { lapCount: lap.lapCount, progressMeters: limitStatus.progressMeters };
      }
      // Playable Qualifying: the AI's best VALID lap, feeding the same
      // shared times the player writes (see Car.tsx) so the grid compares
      // clean laps on both sides. Unconditional on mode - in a race the
      // overlay simply compares bests instead of first laps.
      if (allWheelsOffTrack(track, wheelGroundPositions(body))) {
        aiLapInvalidRef.current = true;
      }
      if (lap.crossedFinishLine && lap.lastLapSeconds !== null) {
        if (qualifyingRef?.current && !aiLapInvalidRef.current) {
          const prev = qualifyingRef.current.ai;
          if (prev === null || lap.lastLapSeconds < prev) {
            qualifyingRef.current.ai = lap.lastLapSeconds;
          }
        }
        aiLapInvalidRef.current = false;
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
    const controls = computeAIControls(racingLine, pos.x, pos.z, yaw, speedMs);

    // Grid start (Scene.tsx) - see Car.tsx's own comment on the identical gate.
    const raceStarted = raceStartRef?.current ?? true;
    const gatedControls = raceStarted ? controls : { ...controls, throttle: 0 };
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
      1,
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
    const downforceN = computeDownforceN(controller.currentVehicleSpeed(), "high-downforce");
    body.applyImpulse({ x: 0, y: -downforceN * world.timestep, z: 0 }, true);
    applyDragImpulse(body, "high-downforce", world.timestep);
    applySurfaceDragImpulse(body, meanSurfaceDrag(surfaceSamples), world.timestep);
  });

  useFrame(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    const pos = chassisRef.current?.translation();
    if (minimapMarkerRef?.current && pos) {
      minimapMarkerRef.current.setAttribute("cx", pos.x.toFixed(1));
      minimapMarkerRef.current.setAttribute("cy", pos.z.toFixed(1));
    }
    // Opponent half of the race audio snapshot (see
    // app/race/RaceAudioRig.tsx) - same rpm policy as the player's own
    // shift bar, so the two engines read as the same machinery.
    if (audioRef && pos) {
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
      position={[spawnX, 1, spawnZ]}
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
