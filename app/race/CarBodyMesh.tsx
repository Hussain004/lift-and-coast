"use client";

import * as THREE from "three";
import { CAR_WHEELS } from "@/lib/physics/vehicle";
import { FLAP_CLOSED_INCLINE_RAD, computeAccentColor } from "@/lib/race/carBody";
import { FLAP_PIVOT, buildCarGeometry, buildWheelGeometry, type CarGeometry } from "@/lib/race/carSculpt";
import { useQuality } from "./renderQuality";

// Shared renderer for the car (see lib/race/carSculpt.ts for the shapes):
// the player's car, the ghost, every AI rival, every remote car and the
// garage showroom all draw this. Geometry is cached per livery and colours
// are baked in as vertex colours, so a car is seven draw calls - glossy
// paint, matte carbon, the DRS flap, four wheels - and the grid shares one
// geometry set per team. Materials are cached per finish.

const bodyCache = new Map<string, CarGeometry>();
let wheelGeometry: THREE.BufferGeometry | null = null;
const materialCache = new Map<string, THREE.Material>();

function carGeometry(livery: string, accent: string): CarGeometry {
  const key = `${livery}|${accent}`;
  let geometry = bodyCache.get(key);
  if (!geometry) bodyCache.set(key, (geometry = buildCarGeometry(livery, accent)));
  return geometry;
}

function wheels(): THREE.BufferGeometry {
  return (wheelGeometry ??= buildWheelGeometry());
}

type Finish = "paint" | "carbon" | "rubber";

const FINISH: Record<Finish, { roughness: number; metalness: number }> = {
  paint: { roughness: 0.3, metalness: 0.35 },
  carbon: { roughness: 0.55, metalness: 0.3 },
  rubber: { roughness: 0.85, metalness: 0.05 },
};

/** One material per (finish, ghost, studio, tier) - shared by every car. */
function material(finish: Finish, options: { ghost: boolean; studio: boolean; cheap: boolean }): THREE.Material {
  const { ghost, studio, cheap } = options;
  const key = `${finish}|${ghost}|${studio}|${cheap}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const common = { vertexColors: true, transparent: ghost, opacity: ghost ? 0.35 : 1, depthWrite: !ghost };
  const base = FINISH[finish];
  const made = cheap
    ? new THREE.MeshLambertMaterial(common)
    : new THREE.MeshStandardMaterial({
        ...common,
        roughness: studio ? Math.max(0.05, base.roughness - 0.08) : base.roughness,
        metalness: studio ? Math.min(1, base.metalness + 0.08) : base.metalness,
      });
  materialCache.set(key, made);
  return made;
}

/**
 * The body: paint and carbon meshes plus the DRS flap in its pivot group
 * (its leading edge). `flapRef` is the pivot the owner animates (see
 * Car.tsx); without one the flap stays parked shut, which is what the AI,
 * the remote cars and the showroom want.
 */
export function CarBodyShell({
  bodyColor,
  accentColor,
  flapRef,
  ghost = false,
  studio = false,
}: {
  bodyColor: string;
  /** Team secondary paint; derived from the primary when absent. */
  accentColor?: string;
  flapRef?: React.RefObject<THREE.Group | null>;
  ghost?: boolean;
  studio?: boolean;
}) {
  const { cheapMaterials: cheap } = useQuality();
  const geometry = carGeometry(bodyColor, accentColor ?? computeAccentColor(bodyColor));
  const options = { ghost, studio, cheap };
  return (
    <>
      <mesh geometry={geometry.paint} material={material("paint", options)} castShadow={!ghost} />
      <mesh geometry={geometry.carbon} material={material("carbon", options)} castShadow={!ghost} />
      <group ref={flapRef} position={FLAP_PIVOT}>
        <mesh
          rotation={[FLAP_CLOSED_INCLINE_RAD, 0, 0]}
          geometry={geometry.flap}
          material={material("paint", options)}
          castShadow={!ghost}
        />
      </group>
    </>
  );
}

/**
 * The four wheels on the physics-owned stations. `steerRefs`/`spinRefs`
 * keep the exact group structure the vehicle controllers write to (see
 * Car.tsx / AICar.tsx); pass neither for parked wheels (the showroom).
 */
export function CarWheels({
  steerRefs,
  spinRefs,
  ghost = false,
  studio = false,
}: {
  steerRefs?: React.RefObject<(THREE.Group | null)[]>;
  spinRefs?: React.RefObject<(THREE.Group | null)[]>;
  ghost?: boolean;
  studio?: boolean;
}) {
  const { cheapMaterials: cheap } = useQuality();
  const rubber = material("rubber", { ghost, studio, cheap });
  return (
    <>
      {CAR_WHEELS.map((wheel, i) => (
        <group key={`wheel-${i}`} position={wheel.position}>
          <group ref={steerRefs ? (el) => { steerRefs.current[i] = el; } : undefined}>
            <group ref={spinRefs ? (el) => { spinRefs.current[i] = el; } : undefined}>
              <mesh geometry={wheels()} material={rubber} castShadow={!ghost} />
            </group>
          </group>
        </group>
      ))}
    </>
  );
}
