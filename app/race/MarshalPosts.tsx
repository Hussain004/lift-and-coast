"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { HudSnapshot } from "@/lib/race/hud";
import type { SafetyCarState } from "@/lib/race/safetyCar";
import { computeMarshalPosts, postShowsYellow } from "@/lib/tracks/marshalPosts";
import { buildTerrainGeometry, sampleTerrainHeight } from "@/lib/tracks/terrain";
import type { TrackData } from "@/lib/tracks/types";
import { useQuality } from "./renderQuality";

const HUT_COLOR = "#e9e6de";
const ROOF_COLOR = "#3a3d44";
const POLE_COLOR = "#8a8f99";
const POLE_HEIGHT = 4.4;
const POLE_OFFSET: [number, number] = [0.95, 0.55];
const YELLOW = "#ffd400";

const dummy = new THREE.Object3D();

function colored(g: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute("position").count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

/** Hut, roof and flag pole as one vertex-coloured mesh: every post is one instance. */
function buildHutGeometry(): THREE.BufferGeometry {
  const hut = new THREE.BoxGeometry(1.9, 2.3, 1.5).translate(0, 1.15, 0);
  const roof = new THREE.BoxGeometry(2.3, 0.16, 1.9).translate(0, 2.38, 0);
  const pole = new THREE.CylinderGeometry(0.04, 0.05, POLE_HEIGHT, 5).translate(POLE_OFFSET[0], POLE_HEIGHT / 2, POLE_OFFSET[1]);
  const parts = [colored(hut.toNonIndexed(), HUT_COLOR), colored(roof.toNonIndexed(), ROOF_COLOR), colored(pole.toNonIndexed(), POLE_COLOR)];
  const positions: number[] = [];
  const colors: number[] = [];
  for (const g of parts) {
    positions.push(...(g.getAttribute("position").array as Float32Array));
    colors.push(...(g.getAttribute("color").array as Float32Array));
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  merged.computeVertexNormals();
  return merged;
}

/**
 * Marshal posts (see lib/tracks/marshalPosts.ts): two instanced meshes, so two
 * draw calls for the whole circuit. The flags stay furled until the player's
 * flag system reports a stopped car (hud.yellowStation) or a safety car / VSC
 * is out; the posts covering that stretch then wave yellow. Off on Low.
 */
export function MarshalPosts({
  track,
  hudRef,
  safetyCarRef,
}: {
  track: TrackData;
  hudRef: React.RefObject<HudSnapshot>;
  safetyCarRef?: React.RefObject<SafetyCarState>;
}) {
  const { crowd } = useQuality();
  const posts = useMemo(() => {
    const terrain = buildTerrainGeometry(track);
    return computeMarshalPosts(track).map((p) => ({ ...p, y: sampleTerrainHeight(terrain, p.x, p.z) ?? p.y }));
  }, [track]);
  const hutGeometry = useMemo(() => buildHutGeometry(), []);
  const flagGeometry = useMemo(() => new THREE.PlaneGeometry(1.7, 1.1).translate(0.85, 0, 0), []);
  const hutRef = useRef<THREE.InstancedMesh>(null);
  const flagRef = useRef<THREE.InstancedMesh>(null);
  const shownRef = useRef<boolean[]>([]);

  useLayoutEffect(() => {
    const huts = hutRef.current;
    const flags = flagRef.current;
    if (!huts || !flags) return;
    const yellow = new THREE.Color(YELLOW);
    posts.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, p.yawRad, 0);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      huts.setMatrixAt(i, dummy.matrix);
      flags.setColorAt(i, yellow);
      dummy.scale.setScalar(0);
      dummy.updateMatrix();
      flags.setMatrixAt(i, dummy.matrix);
    });
    huts.instanceMatrix.needsUpdate = true;
    flags.instanceMatrix.needsUpdate = true;
    if (flags.instanceColor) flags.instanceColor.needsUpdate = true;
    huts.computeBoundingSphere();
    // Flags wave above the huts and are only ever a few; never cull them by a stale sphere.
    flags.frustumCulled = false;
    shownRef.current = posts.map(() => false);
  }, [posts]);

  // Dev builds only: the posts and lap on window for headless checks (see Scene.tsx's __raceState).
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __marshal?: unknown }).__marshal = { posts, track };
  }, [posts, track]);

  useFrame(({ clock }) => {
    const flags = flagRef.current;
    if (!flags) return;
    const everywhere = safetyCarRef ? safetyCarRef.current.phase !== "none" : false;
    const incident = hudRef.current.yellowStation;
    let changed = false;
    posts.forEach((p, i) => {
      const on = everywhere || postShowsYellow(p.stationMeters, incident, track.lengthMeters);
      if (!on && !shownRef.current[i]) return;
      shownRef.current[i] = on;
      changed = true;
      // The flag hangs from the pole top and flaps by yawing about it.
      const wave = Math.sin(clock.elapsedTime * 7 + i) * 0.35;
      const c = Math.cos(p.yawRad);
      const s = Math.sin(p.yawRad);
      dummy.position.set(
        p.x + POLE_OFFSET[0] * c + POLE_OFFSET[1] * s,
        p.y + POLE_HEIGHT - 0.6,
        p.z - POLE_OFFSET[0] * s + POLE_OFFSET[1] * c
      );
      dummy.rotation.set(0, p.yawRad + wave, 0);
      dummy.scale.setScalar(on ? 1 : 0);
      dummy.updateMatrix();
      flags.setMatrixAt(i, dummy.matrix);
    });
    if (changed) flags.instanceMatrix.needsUpdate = true;
  });

  if (!crowd || posts.length === 0) return null;
  return (
    <>
      <instancedMesh ref={hutRef} args={[hutGeometry, undefined, posts.length]}>
        <meshLambertMaterial vertexColors />
      </instancedMesh>
      <instancedMesh ref={flagRef} args={[flagGeometry, undefined, posts.length]}>
        <meshBasicMaterial side={THREE.DoubleSide} />
      </instancedMesh>
    </>
  );
}
