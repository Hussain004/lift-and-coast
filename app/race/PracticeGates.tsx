"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type * as THREE from "three";
import type { HudSnapshot } from "@/lib/race/hud";

/**
 * Championship practice: a glowing marker post on each racing-line gate
 * that has not been driven through yet (see lib/race/practiceProgrammes.ts).
 * The car writes the gates and the hit flags into the HUD snapshot; this only
 * draws them, hiding a post the moment it is hit.
 */
export function PracticeGates({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(() => {
    const group = groupRef.current;
    const hud = hudRef.current;
    if (!group) return;
    const gates = hud.gates;
    group.visible = gates.length > 0;
    group.children.forEach((child, i) => {
      const gate = gates[i];
      child.visible = !!gate && !hud.gateHits[i];
      if (gate) child.position.set(gate.x, gate.y + 6, gate.z);
    });
  });
  return (
    <group ref={groupRef} visible={false}>
      {Array.from({ length: 10 }, (_, i) => (
        <mesh key={i} visible={false}>
          <cylinderGeometry args={[1.5, 1.5, 12, 12, 1, true]} />
          <meshBasicMaterial color="#39e6c0" transparent opacity={0.6} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
