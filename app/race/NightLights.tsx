"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LAMP_HEIGHT_METERS, computeFloodlights, nearestLamps } from "@/lib/tracks/floodlights";
import type { TrackData } from "@/lib/tracks/types";
import { useQuality } from "./renderQuality";

// Night racing: a floodlight mast along the circuit every ~90 m (drawn
// always, with bright emissive heads) and a small fixed pool
// of real point lights that hop between the masts nearest the player - a
// constant light count, so nothing recompiles as the car moves - plus a
// forward headlight so the corner ahead is always readable.

const POOL = 4;
const LAMP_INTENSITY = 4500;
const LAMP_REACH_METERS = 170;

const fade = (distance: number) => Math.max(0, 1 - distance / LAMP_REACH_METERS) ** 2;

export function NightLights({
  track,
  target,
}: {
  track: TrackData;
  target: React.RefObject<THREE.Group | null>;
}) {
  const { cheapMaterials } = useQuality();
  const lamps = useMemo(() => computeFloodlights(track), [track]);
  const { masts, heads } = useMemo(() => {
    const mastParts: THREE.BufferGeometry[] = [];
    const headParts: THREE.BufferGeometry[] = [];
    for (const lamp of lamps) {
      const mast = new THREE.BoxGeometry(0.4, LAMP_HEIGHT_METERS, 0.4);
      mast.translate(lamp.x, lamp.y + LAMP_HEIGHT_METERS / 2, lamp.z);
      mastParts.push(mast);
      const head = new THREE.BoxGeometry(2.6, 0.35, 1.6);
      head.translate(lamp.x, lamp.y + LAMP_HEIGHT_METERS + 0.2, lamp.z);
      headParts.push(head);
    }
    return {
      masts: mastParts.length ? mergeGeometries(mastParts, false) : null,
      heads: headParts.length ? mergeGeometries(headParts, false) : null,
    };
  }, [lamps]);

  const lightRefs = useRef<(THREE.PointLight | null)[]>([]);
  const spotRef = useRef<THREE.SpotLight>(null);
  const spotTargetRef = useRef<THREE.Object3D>(null);
  const forward = useMemo(() => new THREE.Vector3(), []);
  const position = useMemo(() => new THREE.Vector3(), []);
  const poolSize = cheapMaterials ? 2 : POOL;

  useFrame(() => {
    const car = target.current;
    if (!car) return;
    car.getWorldPosition(position);
    const near = nearestLamps(lamps, position.x, position.z, poolSize);
    lightRefs.current.forEach((light, slot) => {
      if (!light) return;
      const lamp = lamps[near[slot]];
      if (!lamp) {
        light.intensity = 0;
        return;
      }
      light.position.set(lamp.x, lamp.y + LAMP_HEIGHT_METERS - 0.5, lamp.z);
      light.intensity = LAMP_INTENSITY * fade(Math.hypot(lamp.x - position.x, lamp.z - position.z));
    });
    const spot = spotRef.current;
    const spotTarget = spotTargetRef.current;
    if (spot && spotTarget) {
      forward.set(0, 0, -1).applyQuaternion(car.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
      spot.position.set(position.x - forward.x * 1.5, position.y + 2.2, position.z - forward.z * 1.5);
      spotTarget.position.set(position.x + forward.x * 30, position.y - 0.5, position.z + forward.z * 30);
      spotTarget.updateMatrixWorld();
      spot.target = spotTarget;
    }
  });

  return (
    <>
      {masts && (
        <mesh geometry={masts}>
          <meshBasicMaterial color="#1b2029" />
        </mesh>
      )}
      {heads && (
        <mesh geometry={heads}>
          <meshBasicMaterial color="#fff4d8" toneMapped={false} fog={false} />
        </mesh>
      )}
      {Array.from({ length: poolSize }, (_, i) => (
        <pointLight
          key={i}
          ref={(el) => {
            lightRefs.current[i] = el;
          }}
          color="#fff0d8"
          intensity={0}
          distance={LAMP_REACH_METERS}
          decay={2}
        />
      ))}
      <spotLight ref={spotRef} color="#fff6e8" intensity={550} distance={100} angle={0.55} penumbra={0.7} decay={1.6} />
      <object3D ref={spotTargetRef} />
    </>
  );
}
