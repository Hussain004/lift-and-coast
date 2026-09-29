"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { HudSnapshot } from "@/lib/race/hud";
import { getPitLane } from "@/lib/tracks/pitLane";
import type { TrackData } from "@/lib/tracks/types";

// Wheel stations relative to the car centre (metres): the crew works at them.
const STATIONS: [number, number][] = [
  [-0.95, -1.7],
  [0.95, -1.7],
  [-0.95, 1.7],
  [0.95, 1.7],
];

/**
 * The pit crew: four wheel-gun operators, a front and a rear jack, and the
 * lollipop man ahead of the car - red while the stop is under way, green the
 * moment it is done. Drawn only while the player's stop is being serviced;
 * everything is a handful of cheap meshes parked in the box, no per-frame
 * allocation. Renders nothing on circuits without a drivable pit lane.
 */
export function PitCrew({ track, hudRef }: { track: TrackData; hudRef: React.RefObject<HudSnapshot> }) {
  const lane = useMemo(() => getPitLane(track), [track]);
  const rootRef = useRef<THREE.Group>(null);
  const signRef = useRef<THREE.Mesh>(null);
  const gunRefs = useRef<(THREE.Group | null)[]>([]);
  const wasServiceRef = useRef(false);
  const doneAtRef = useRef(-10);
  const materials = useMemo(
    () => ({
      suit: new THREE.MeshStandardMaterial({ color: "#2f5fc4", roughness: 0.8 }),
      helmet: new THREE.MeshStandardMaterial({ color: "#f5f5f5", roughness: 0.4 }),
      jack: new THREE.MeshStandardMaterial({ color: "#d7263d", roughness: 0.6 }),
      gun: new THREE.MeshStandardMaterial({ color: "#2a2c33", roughness: 0.5, metalness: 0.4 }),
      red: new THREE.MeshBasicMaterial({ color: "#e0202a" }),
      green: new THREE.MeshBasicMaterial({ color: "#20c05a" }),
    }),
    []
  );
  const geo = useMemo(
    () => ({
      body: new THREE.CapsuleGeometry(0.22, 0.85, 4, 8),
      head: new THREE.SphereGeometry(0.17, 10, 8),
      gun: new THREE.BoxGeometry(0.12, 0.12, 0.45),
      jack: new THREE.BoxGeometry(0.5, 0.4, 0.5),
      pole: new THREE.CylinderGeometry(0.03, 0.03, 1.9, 6),
      sign: new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20),
    }),
    []
  );

  useFrame((state) => {
    const root = rootRef.current;
    if (!root) return;
    const hud = hudRef.current;
    const service = hud.pitPhase === "service";
    const now = state.clock.elapsedTime;
    if (wasServiceRef.current && !service) doneAtRef.current = now;
    wasServiceRef.current = service;
    const recentlyDone = now - doneAtRef.current < 1.6;
    root.visible = service || recentlyDone;
    if (!root.visible) return;
    if (signRef.current) signRef.current.material = service ? materials.red : materials.green;
    // The gun operators lean in and out while the tyres come off and go on.
    gunRefs.current.forEach((g, i) => {
      if (!g) return;
      const swing = service ? Math.sin(now * 9 + i * 1.3) * 0.06 : 0;
      g.position.x = STATIONS[i][0] + (STATIONS[i][0] < 0 ? -1 : 1) * (0.55 + swing);
    });
  });

  if (!lane) return null;
  const { x, y, z, headingRad } = lane.box;
  return (
    <group ref={rootRef} position={[x, y, z]} rotation={[0, headingRad, 0]} visible={false}>
      {STATIONS.map(([sx, sz], i) => (
        <group
          key={i}
          ref={(el) => {
            gunRefs.current[i] = el;
          }}
          position={[sx + (sx < 0 ? -0.55 : 0.55), 0, sz]}
        >
          <mesh geometry={geo.body} material={materials.suit} position={[0, 0.85, 0]} castShadow />
          <mesh geometry={geo.head} material={materials.helmet} position={[0, 1.6, 0]} />
          <mesh geometry={geo.gun} material={materials.gun} position={[sx < 0 ? 0.35 : -0.35, 0.55, 0]} />
        </group>
      ))}
      <mesh geometry={geo.jack} material={materials.jack} position={[0, 0.2, -2.35]} />
      <mesh geometry={geo.jack} material={materials.jack} position={[0, 0.2, 2.35]} />
      {/* Lollipop man, ahead of the nose on the garage side. */}
      <group position={[lane.sign * 1.6, 0, -4.3]}>
        <mesh geometry={geo.body} material={materials.suit} position={[0, 0.85, 0]} />
        <mesh geometry={geo.head} material={materials.helmet} position={[0, 1.6, 0]} />
        <mesh geometry={geo.pole} material={materials.gun} position={[-lane.sign * 0.35, 1.2, 0]} />
        <mesh ref={signRef} geometry={geo.sign} material={materials.red} position={[-lane.sign * 0.35, 2.2, 0]} rotation={[Math.PI / 2, 0, 0]} />
      </group>
    </group>
  );
}
