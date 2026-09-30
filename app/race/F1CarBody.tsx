"use client";

import { useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { TireCompoundId } from "@/lib/physics/tireModel";
import type { DamageState } from "@/lib/physics/damage";
import { wantsFarLod } from "@/lib/race/carLod";
import { CarBodyShell, CarWheels, FarCarShell } from "./CarBodyMesh";

const cameraDelta = new THREE.Vector3();

/**
 * The F1 car visual shared by the player (Car.tsx), the AI rivals
 * (AICar.tsx), the remote cars (RemoteCar.tsx) and the ghost replay: the
 * shared shell from ./CarBodyMesh (merged panels, the active-aero flap in its pivot
 * group, helmet, halo) plus its dressed wheels on the physics-owned
 * stations. Visual only - the solid colliders stay the chassis cuboid and
 * the mesh-less raycast wheels (see the colliders={false} comment in
 * Car.tsx), and the steer/spin animation groups keep their exact structure,
 * so handling is untouched.
 */
export function F1CarBody({
  bodyColor,
  accentColor,
  steerRefs,
  spinRefs,
  flapRef,
  damageRef,
  compoundRef,
  /** Ghost replay (see Car.tsx): translucent silhouette of the real car,
   * no shadows, wheels parked - a replay pose, not a driven chassis. */
  ghost = false,
  raceNumber = null,
  lod = false,
}: {
  /** Swap to a single merged low-poly mesh when far from the camera (AI and
   * remote rivals; the player's and the showroom's car always draw in full). */
  lod?: boolean;
  /** The number worn on the engine cover; none if absent (remote cars, the showroom). */
  raceNumber?: number | null;
  bodyColor: string;
  /** Team secondary paint for the livery stripes (see page.tsx's roster
   * pick); derived from the primary when the caller has no second color -
   * rivals and remote cars. */
  accentColor?: string;
  steerRefs: React.RefObject<(THREE.Group | null)[]>;
  spinRefs: React.RefObject<(THREE.Group | null)[]>;
  /** Animated by the owner (see Car.tsx): rotates the rear-wing active-aero flap
   * open in low-drag mode. Absent, the flap parks at its shut inclination -
   * the AI never deploys. */
  flapRef?: React.RefObject<THREE.Group | null>;
  /** The player's live damage: the wings droop and break off with it. */
  damageRef?: React.RefObject<DamageState>;
  /** The player's live tyre pick (see CarWheels) - sidewall stripe colour. */
  compoundRef?: React.RefObject<TireCompoundId>;
  ghost?: boolean;
}) {
  const nearRef = useRef<THREE.Group>(null);
  const farRef = useRef<THREE.Group>(null);
  const isFarRef = useRef(false);
  useFrame(({ camera }) => {
    const near = nearRef.current;
    const far = farRef.current;
    if (!lod || !near || !far) return;
    near.getWorldPosition(cameraDelta).sub(camera.position);
    const wantFar = wantsFarLod(isFarRef.current, cameraDelta.lengthSq());
    if (wantFar === isFarRef.current) return;
    isFarRef.current = wantFar;
    near.visible = !wantFar;
    far.visible = wantFar;
  });
  return (
    <>
      {lod && <FarCarShell bodyColor={bodyColor} accentColor={accentColor} groupRef={farRef} />}
      <group ref={nearRef}>
        <CarBodyShell
          bodyColor={bodyColor}
          accentColor={accentColor}
          flapRef={flapRef}
          damageRef={damageRef}
          ghost={ghost}
          raceNumber={raceNumber}
        />
        <CarWheels steerRefs={steerRefs} spinRefs={spinRefs} compoundRef={compoundRef} ghost={ghost} />
      </group>
    </>
  );
}
