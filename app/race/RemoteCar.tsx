"use client";

import { useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { F1CarBody } from "./F1CarBody";
import { createGearboxState, gearboxSpeedMs, rpmForGear, updateGearbox } from "@/lib/physics/gearbox";
import { yawFromQuaternion } from "@/lib/physics/vehicle";
import { limiterAmount, rpmTo01, type AudioSnapshot } from "@/lib/audio/raceAudio";
import {
  bracketSnapshots,
  interpolatePose,
  renderTimestamp,
  type CarPose,
  type TimedSnapshot,
} from "@/lib/net/snapshots";

export interface RemoteCarFrame {
  pose: CarPose;
  speedMs: number;
}

/**
 * A remotely-driven car (plan section 16): pure rendering, no physics.
 * Guests don't simulate anyone but themselves - every other car (host,
 * other guests, AI) arrives as snapshots (see NetClient) and is posed
 * here by interpolation, with wheels spun from the snapshot speed. No
 * collider, no controller, no lap timer: laps and timing are the host's
 * job, this car just needs to look right. Missing buffers (slot with no
 * snapshots yet) render parked at the origin until data arrives - a
 * joined-late car fades in by construction rather than needing a case.
 */
export function RemoteCar({
  buffersRef,
  slot,
  markerIndex,
  minimapMarkerEls,
  bodyColor = "#ff5a3c",
  audioRef,
}: {
  /** Race audio snapshot: a remote car fills its rival slot like an AI car
   * does (rpm from the same auto-shift policy on its replicated speed). */
  audioRef?: React.RefObject<AudioSnapshot>;
  /** Per-slot snapshot buffers owned by NetClient (see snapshots.ts). */
  buffersRef?: React.RefObject<Record<number, TimedSnapshot<RemoteCarFrame>[]>>;
  /** Grid slot this car renders (see gridSlot in grid.ts). */
  slot: number;
  /** Index into the minimap dots (rivals order, see page.tsx). */
  markerIndex: number;
  minimapMarkerEls?: React.RefObject<(SVGCircleElement | null)[]>;
  bodyColor?: string;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const steerRefs = useRef<(THREE.Group | null)[]>([]);
  const spinRefs = useRef<(THREE.Group | null)[]>([]);
  const spinAngleRef = useRef(0);
  const lastFrameRef = useRef<TimedSnapshot<RemoteCarFrame> | null>(null);
  const gearboxRef = useRef(createGearboxState(true));
  const gearboxClockRef = useRef(0);
  const lastSpeedRef = useRef(0);

  useFrame((_, dt) => {
    const group = groupRef.current;
    if (!group) return;
    const buffer = buffersRef?.current?.[slot];
    const atMs = renderTimestamp(Date.now());
    const bracket = buffer ? bracketSnapshots(buffer, atMs) : null;
    let frame: TimedSnapshot<RemoteCarFrame> | null = null;
    if (bracket !== null) {
      if ("exact" in bracket) {
        frame = { atMs, state: bracket.exact };
      } else {
        const u = bracket.u;
        frame = {
          atMs,
          state: {
            pose: interpolatePose(bracket.a.state.pose, bracket.b.state.pose, u),
            speedMs:
              bracket.a.state.speedMs + (bracket.b.state.speedMs - bracket.a.state.speedMs) * u,
          },
        };
      }
    }
    if (frame) {
      lastFrameRef.current = frame;
      group.position.set(
        frame.state.pose.position[0],
        frame.state.pose.position[1],
        frame.state.pose.position[2]
      );
      group.quaternion.set(
        frame.state.pose.rotation[0],
        frame.state.pose.rotation[1],
        frame.state.pose.rotation[2],
        frame.state.pose.rotation[3]
      );
      group.visible = true;
    } else if (!lastFrameRef.current) {
      group.visible = false;
      return;
    }
    const speed = (frame ?? lastFrameRef.current)?.state.speedMs ?? 0;
    const shown = frame ?? lastFrameRef.current;
    if (audioRef && shown) {
      // Remote snapshots arrive on the render clock, not the fixed physics
      // clock. Advance the replicated gearbox at a capped 60Hz-equivalent
      // so a 144Hz browser cannot make its top-gear audio hunt faster.
      gearboxClockRef.current += Math.min(dt, 0.25);
      let ticks = Math.floor(gearboxClockRef.current * 60);
      if (ticks > 8) {
        ticks = 8;
        gearboxClockRef.current = ticks / 60;
      }
      while (ticks > 0) {
        updateGearbox(gearboxRef.current, { speedMs: Math.abs(speed), shiftUp: false, shiftDown: false });
        gearboxClockRef.current -= 1 / 60;
        ticks -= 1;
      }
      const gearbox = gearboxRef.current;
      const audioRpm = rpmForGear(gearboxSpeedMs(gearbox, speed), gearbox.gear);
      const [qx, qy, qz, qw] = shown.state.pose.rotation;
      const [vx, , vz] = shown.state.pose.linvel;
      // No inputs cross the wire: gaining speed reads as throttle.
      const accelerating = speed > lastSpeedRef.current + 0.01;
      audioRef.current.opponents[markerIndex] = {
        rpm01: rpmTo01(audioRpm),
        limiter01: limiterAmount(audioRpm),
        throttle01: accelerating ? 1 : 0.15,
        skid01: 0,
        x: group.position.x,
        z: group.position.z,
        yawRad: yawFromQuaternion(qx, qy, qz, qw),
        vx,
        vz,
        gear: gearbox.gear,
        kerb01: 0,
        shiftSerial: 0,
      };
    }
    lastSpeedRef.current = speed;
    // Fixed wheel radius approximation for the spin read - matches the
    // visual radius closely enough that nobody can tell at race distance.
    spinAngleRef.current += (speed / 0.33) * Math.min(dt, 0.1);
    spinRefs.current.forEach((spin) => {
      if (spin) spin.rotation.x = spinAngleRef.current;
    });
    const marker = minimapMarkerEls?.current?.[markerIndex];
    if (marker) {
      marker.setAttribute("cx", group.position.x.toFixed(1));
      marker.setAttribute("cy", group.position.z.toFixed(1));
    }
  });

  return (
    <group ref={groupRef} visible={false}>
      <F1CarBody bodyColor={bodyColor} steerRefs={steerRefs} spinRefs={spinRefs} />
    </group>
  );
}

