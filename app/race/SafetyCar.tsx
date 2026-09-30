"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { useBeforePhysicsStep, useRapier } from "@react-three/rapier";
import { lineIndexAtProgress } from "@/lib/ai/racecraft";
import { pushHudEvent, type HudSnapshot } from "@/lib/race/hud";
import type { RaceState } from "@/lib/race/racePosition";
import {
  planSafetyCar,
  safetyCarRadio,
  safetyCarText,
  stepSafetyCar,
  type SafetyCarSetting,
  type SafetyCarState,
} from "@/lib/race/safetyCar";
import { getRacingLine } from "@/lib/tracks/racingLineCache";
import type { TrackData } from "@/lib/tracks/types";
import { F1CarBody } from "./F1CarBody";

/** Sits this far ahead of the race leader while the safety car is out. */
const LEAD_METERS = 45;
/** An AI car parked this slowly, off the pit lane, is "stopped". */
const STOPPED_SPEED_MS = 1.5;

/**
 * Runs the safety-car state machine on the physics clock (see
 * lib/race/safetyCar.ts) and publishes it: the shared state the cars read,
 * the HUD chip, and the banner and radio call at each change. Renders nothing.
 */
export function SafetyCarDriver({
  setting,
  stateRef,
  raceRef,
  raceStartRef,
  hudRef,
  sessionSeedRef,
  raceLaps,
  trackLengthMeters,
}: {
  setting: SafetyCarSetting;
  stateRef: React.RefObject<SafetyCarState>;
  raceRef: React.RefObject<RaceState>;
  raceStartRef: React.RefObject<boolean>;
  hudRef: React.RefObject<HudSnapshot>;
  sessionSeedRef: React.RefObject<number>;
  raceLaps: number;
  trackLengthMeters: number;
}) {
  const { world } = useRapier();
  const plannedRef = useRef(false);
  const stoppedRef = useRef<number[]>([]);
  const lastSerialRef = useRef(0);
  useBeforePhysicsStep(() => {
    const state = stateRef.current;
    const race = raceRef.current;
    const hud = hudRef.current;
    if (!state || !race || !hud || setting === "off") return;
    // The seed is stamped by Scene's mount effect, after this component's:
    // plan on the first tick that can see it.
    if (!plannedRef.current) {
      plannedRef.current = true;
      state.plan = planSafetyCar(setting, raceLaps, sessionSeedRef.current);
    }
    const dt = world.timestep;
    let leader = race.player.lapCount * trackLengthMeters + race.player.progressMeters;
    race.opponents.forEach((o, k) => {
      leader = Math.max(leader, o.lapCount * trackLengthMeters + o.progressMeters);
      const stopped = (o.speedMs ?? 0) < STOPPED_SPEED_MS && !o.inPit;
      stoppedRef.current[k] = stopped ? (stoppedRef.current[k] ?? 0) + dt : 0;
    });
    const event = stepSafetyCar(state, {
      dt,
      leaderLaps: leader / trackLengthMeters,
      raceLaps,
      racing: raceStartRef.current && !hud.chequered,
      stoppedCarSeconds: Math.max(0, ...stoppedRef.current),
      reactive: true,
    });
    if (state.serial !== lastSerialRef.current) {
      lastSerialRef.current = state.serial;
      hud.safetyCarText = safetyCarText(state);
    }
    if (event) {
      const title =
        event.type === "green" ? "GREEN FLAG" : event.kind === "sc" ? "SAFETY CAR" : "VIRTUAL SAFETY CAR";
      pushHudEvent(hud, event.type === "green" ? "good" : "flag", title, safetyCarRadio(event), 4.5);
    }
  });
  return null;
}

const CAR_COLOR = "#0e8f4c";
const ACCENT = "#ffd400";

/**
 * The safety car itself: a visual-only car (no collider, so it can never
 * touch anything) that leads the race leader around the racing line while
 * the safety car is out. The field's pace comes from the speed ceiling, not
 * from following this car.
 */
export function SafetyCarVisual({
  track,
  stateRef,
  raceRef,
}: {
  track: TrackData;
  stateRef: React.RefObject<SafetyCarState>;
  raceRef: React.RefObject<RaceState>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const lightRef = useRef<THREE.Mesh>(null);
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const line = useMemo(() => getRacingLine(track), [track]);
  const smoothRef = useRef({ x: 0, y: 0, z: 0, yaw: 0, ready: false });
  useFrame((state, delta) => {
    const group = groupRef.current;
    const sc = stateRef.current;
    const race = raceRef.current;
    if (!group || !sc || !race) return;
    const smooth = smoothRef.current;
    const out = sc.phase !== "none" && sc.kind === "sc";
    group.visible = out;
    if (!out) {
      smooth.ready = false;
      return;
    }
    let leader = race.player.lapCount * track.lengthMeters + race.player.progressMeters;
    for (const o of race.opponents) leader = Math.max(leader, o.lapCount * track.lengthMeters + o.progressMeters);
    const ahead = (((leader + LEAD_METERS) % track.lengthMeters) + track.lengthMeters) % track.lengthMeters;
    const i = lineIndexAtProgress(ahead, track.lengthMeters, line.length);
    const a = line[i].position;
    const b = line[(i + 3) % line.length].position;
    const yaw = Math.atan2(-(b[0] - a[0]), -(b[2] - a[2]));
    if (!smooth.ready) {
      Object.assign(smooth, { x: a[0], y: a[1], z: a[2], yaw, ready: true });
    }
    const k = 1 - Math.exp(-delta * 12);
    smooth.x += (a[0] - smooth.x) * k;
    smooth.y += (a[1] - smooth.y) * k;
    smooth.z += (a[2] - smooth.z) * k;
    let dyaw = yaw - smooth.yaw;
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    smooth.yaw += dyaw * k;
    group.position.set(smooth.x, smooth.y + 0.5, smooth.z);
    group.rotation.y = smooth.yaw;
    if (lightRef.current) lightRef.current.visible = Math.floor(state.clock.elapsedTime * 4) % 2 === 0;
  });
  return (
    <group ref={groupRef} visible={false}>
      <F1CarBody bodyColor={CAR_COLOR} accentColor={ACCENT} steerRefs={steerRefs} spinRefs={spinRefs} />
      {/* Roof light bar, flashing amber. */}
      <mesh ref={lightRef} position={[0, 0.78, 0.5]}>
        <boxGeometry args={[0.7, 0.08, 0.16]} />
        <meshBasicMaterial color="#ffb000" toneMapped={false} />
      </mesh>
    </group>
  );
}
