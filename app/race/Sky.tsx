"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";

// Sky dome: zenith-to-horizon gradient, a sun disc with a soft halo, a ring
// of hazy hills on the horizon, and (for cloudy weather) a ring of flattened
// cloud puffs at altitude. Drawn first and unfogged around the camera like a
// skybox. Unlit vertex-coloured meshes - about the cost of the clear it
// replaces. The scene fog uses the same horizon colour, so terrain fades
// into it.

const RADIUS = 120;

function hillHeight(angle: number): number {
  return (
    6 +
    5 * Math.sin(angle * 3 + 1.3) +
    3 * Math.sin(angle * 7 + 0.4) +
    1.6 * Math.sin(angle * 17 + 2.2) +
    0.8 * Math.sin(angle * 31)
  );
}

// Cloud puffs: flattened spheres on a ring at altitude. `cover` (0..1) sets
// how many of the ring's slots are filled - a clear sky gets a few scattered
// puffs, overcast a near-continuous ceiling. Placement is deterministic (two
// hashed randoms per slot) so the sky never reshuffles between renders.
const CLOUD_SLOTS = 26;

function hash01(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

interface CloudSlot {
  angle: number;
  altitude: number;
  scale: number;
  filled: boolean;
}

function cloudSlot(index: number, cover: number): CloudSlot {
  const rand1 = hash01(index + 0.5);
  const rand2 = hash01(index + 100.5);
  return {
    angle: (index / CLOUD_SLOTS) * Math.PI * 2 + rand1 * 0.2,
    altitude: 26 + rand2 * 22,
    scale: 14 + rand1 * 16,
    // Fill the first `cover` share of slots (with jitter at the edge so the
    // boundary reads as scattered cloud, not a hard line).
    filled: ((index + rand1 * 5) % CLOUD_SLOTS) / CLOUD_SLOTS < cover,
  };
}

export function SkyDome({
  zenith,
  horizon,
  hills,
  sunDirection,
  sunColor,
  cloudCover = 0,
  cloudColor = "#e8ecf2",
}: {
  zenith: string;
  horizon: string;
  hills: string;
  sunDirection: [number, number, number];
  sunColor: string;
  /** 0 = clear sky, 1 = full overcast ceiling. */
  cloudCover?: number;
  cloudColor?: string;
}) {
  const group = useRef<THREE.Group>(null);
  const { dome, ring, sun, halo, clouds } = useMemo(() => {
    const top = new THREE.Color(zenith);
    const low = new THREE.Color(horizon);
    const dome = new THREE.SphereGeometry(RADIUS, 24, 14);
    const pos = dome.getAttribute("position");
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, pos.getY(i) / RADIUS);
      c.copy(low).lerp(top, Math.pow(t, 0.55));
      c.toArray(colors, i * 3);
    }
    dome.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Hills: a jagged band just above the horizon, tinted toward the
    // horizon colour (aerial perspective) and fading into it at the base.
    const segments = 96;
    const r = RADIUS * 0.94;
    const far = new THREE.Color(hills).lerp(low, 0.45);
    const ringPos: number[] = [];
    const ringCol: number[] = [];
    const p = (ang: number, y: number) => [Math.cos(ang) * r, y, Math.sin(ang) * r];
    for (let k = 0; k < segments; k++) {
      const a0 = (k / segments) * Math.PI * 2;
      const a1 = ((k + 1) / segments) * Math.PI * 2;
      const h0 = hillHeight(a0);
      const h1 = hillHeight(a1);
      const quad = [p(a0, -4), p(a1, -4), p(a1, h1), p(a0, -4), p(a1, h1), p(a0, h0)];
      const shade = [low, low, far, low, far, far];
      quad.forEach((v, i) => {
        ringPos.push(...v);
        ringCol.push(shade[i].r, shade[i].g, shade[i].b);
      });
    }
    const ring = new THREE.BufferGeometry();
    ring.setAttribute("position", new THREE.Float32BufferAttribute(ringPos, 3));
    ring.setAttribute("color", new THREE.Float32BufferAttribute(ringCol, 3));

    // The disc faces the dome's centre (the camera) from the sun's bearing.
    const dir = new THREE.Vector3(...sunDirection).normalize();
    const sun = new THREE.CircleGeometry(4.5, 20);
    sun.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate()));
    sun.translate(dir.x * RADIUS * 0.9, dir.y * RADIUS * 0.9, dir.z * RADIUS * 0.9);

    // A soft halo around the disc: a larger, fainter circle on the same
    // bearing, additively blended so it reads as glow rather than a ring.
    const halo = new THREE.CircleGeometry(11, 24);
    halo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().negate()));
    halo.translate(dir.x * RADIUS * 0.895, dir.y * RADIUS * 0.895, dir.z * RADIUS * 0.895);

    // Cloud puffs: one flattened sphere per filled slot.
    const clouds: Array<{ position: [number, number, number]; scale: number }> = [];
    for (let i = 0; i < CLOUD_SLOTS; i++) {
      const slot = cloudSlot(i, cloudCover);
      if (!slot.filled) continue;
      clouds.push({
        position: [Math.cos(slot.angle) * RADIUS * 0.8, slot.altitude, Math.sin(slot.angle) * RADIUS * 0.8],
        scale: slot.scale,
      });
    }
    return { dome, ring, sun, halo, clouds };
  }, [zenith, horizon, hills, sunDirection, cloudCover]);

  useFrame(({ camera }) => {
    group.current?.position.copy(camera.position);
  });

  return (
    <group ref={group}>
      <mesh geometry={dome} renderOrder={-30}>
        <meshBasicMaterial vertexColors side={THREE.BackSide} fog={false} depthWrite={false} />
      </mesh>
      <mesh geometry={ring} renderOrder={-20}>
        <meshBasicMaterial vertexColors side={THREE.DoubleSide} fog={false} depthWrite={false} />
      </mesh>
      <mesh geometry={halo} renderOrder={-26}>
        <meshBasicMaterial
          color={sunColor}
          fog={false}
          depthWrite={false}
          transparent
          opacity={0.22}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={sun} renderOrder={-25}>
        <meshBasicMaterial color={sunColor} fog={false} depthWrite={false} toneMapped={false} />
      </mesh>
      {clouds.map((cloud, index) => (
        <mesh key={index} position={cloud.position} scale={[cloud.scale, cloud.scale * 0.32, cloud.scale * 0.7]} renderOrder={-15}>
          <sphereGeometry args={[1, 10, 8]} />
          <meshBasicMaterial color={cloudColor} fog={false} depthWrite={false} transparent opacity={cloudCover > 0.6 ? 0.82 : 0.6} />
        </mesh>
      ))}
    </group>
  );
}
