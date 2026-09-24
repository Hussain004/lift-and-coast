"use client";

import type * as THREE from "three";
import type { TireCompoundId } from "@/lib/physics/tireModel";
import { CarBodyShell, CarWheels } from "./CarBodyMesh";

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
  compoundRef,
  /** Ghost replay (see Car.tsx): translucent silhouette of the real car,
   * no shadows, wheels parked - a replay pose, not a driven chassis. */
  ghost = false,
}: {
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
  /** The player's live tyre pick (see CarWheels) - sidewall stripe colour. */
  compoundRef?: React.RefObject<TireCompoundId>;
  ghost?: boolean;
}) {
  return (
    <>
      <CarBodyShell
        bodyColor={bodyColor}
        accentColor={accentColor}
        flapRef={flapRef}
        ghost={ghost}
      />
      <CarWheels steerRefs={steerRefs} spinRefs={spinRefs} compoundRef={compoundRef} ghost={ghost} />
    </>
  );
}
