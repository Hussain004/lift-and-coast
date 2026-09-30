"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { useFrame } from "@react-three/fiber";
import { CAR_WHEELS } from "@/lib/physics/vehicle";
import type { TireCompoundId } from "@/lib/physics/tireModel";
import { FLAP_CLOSED_INCLINE_RAD, computeAccentColor } from "@/lib/race/carBody";
import {
  STEERING_WHEEL_CENTER_Y,
  STEERING_WHEEL_CENTER_Z,
  STEERING_WHEEL_HALF_HEIGHT,
  STEERING_WHEEL_HALF_WIDTH,
} from "@/lib/race/helmetView";
import {
  COMPOUND_STRIPE_COLOR,
  FLAP_PIVOT,
  FRONT_WING_PIVOT,
  REAR_WING_PIVOT,
  buildCarGeometry,
  buildWheelGeometry,
  type CarGeometry,
} from "@/lib/race/carSculpt";
import type { DamageState } from "@/lib/physics/damage";
import { useQuality } from "./renderQuality";

// Shared renderer for the car (see lib/race/carSculpt.ts for the shapes):
// the player's car, the ghost, every AI rival, every remote car and the
// garage showroom all draw this. Geometry is cached per livery and colours
// are baked in as vertex colours, so a car is seven draw calls - glossy
// paint, matte carbon, the active-aero flap, four wheels - and the grid shares one
// geometry set per team. Materials are cached per finish.

const bodyCache = new Map<string, CarGeometry>();
const wheelCache = new Map<TireCompoundId, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();

function carGeometry(livery: string, accent: string): CarGeometry {
  const key = `${livery}|${accent}`;
  let geometry = bodyCache.get(key);
  if (!geometry) bodyCache.set(key, (geometry = buildCarGeometry(livery, accent)));
  return geometry;
}

function wheels(compound: TireCompoundId): THREE.BufferGeometry {
  let geometry = wheelCache.get(compound);
  if (!geometry) wheelCache.set(compound, (geometry = buildWheelGeometry(COMPOUND_STRIPE_COLOR[compound])));
  return geometry;
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
 * The body: paint and carbon meshes plus the active-aero flap in its pivot group
 * (its leading edge). `flapRef` is the pivot the owner animates (see
 * Car.tsx); without one the flap stays parked shut, which is what the AI,
 * the remote cars and the showroom want.
 */
/**
 * The rear rain light every car shows in the wet (the real rule). One shared
 * material for the whole grid: TrackFx's RainLightDriver flashes it, so no
 * car does any per-frame work. Hidden (invisible material) when dry.
 */
export const rainLightMaterial = new THREE.MeshBasicMaterial({ color: "#ff1414", toneMapped: false, visible: false });
const rainLightGeometry = new THREE.BoxGeometry(0.18, 0.1, 0.03);

// Race numbers: one small transparent decal texture per number, shared by
// every car that wears it, laid on the engine cover where the chase camera
// looks down on it.
const numberMaterials = new Map<number, THREE.Material>();
const numberGeometry = new THREE.PlaneGeometry(0.62, 0.34).rotateX(-Math.PI / 2);

function numberMaterial(n: number): THREE.Material | null {
  if (typeof document === "undefined") return null;
  let material = numberMaterials.get(n);
  if (!material) {
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 64;
    const g = c.getContext("2d");
    if (!g) return null;
    g.font = "900 54px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 8;
    g.strokeStyle = "rgba(10,10,14,0.9)";
    g.strokeText(String(n), 64, 34);
    g.fillStyle = "#ffffff";
    g.fillText(String(n), 64, 34);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    numberMaterials.set(n, material);
  }
  return material;
}

export function CarBodyShell({
  bodyColor,
  accentColor,
  flapRef,
  damageRef,
  ghost = false,
  studio = false,
  raceNumber = null,
}: {
  raceNumber?: number | null;
  /** The player's live component damage: the wings droop, then break off. */
  damageRef?: React.RefObject<DamageState>;
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
  const frontWingRef = useRef<THREE.Group | null>(null);
  const rearWingRef = useRef<THREE.Group | null>(null);
  useFrame(() => {
    const d = damageRef?.current;
    if (!d) return;
    const front = frontWingRef.current;
    if (front) {
      const loss = 1 - d.frontWing;
      front.visible = d.frontWing > 0.12;
      front.rotation.set(-loss * 0.22, 0, loss * 0.3);
      front.position.y = FRONT_WING_PIVOT[1] - loss * 0.05;
    }
    const rear = rearWingRef.current;
    if (rear) {
      const loss = 1 - d.rearWing;
      rear.visible = d.rearWing > 0.12;
      rear.rotation.set(loss * 0.14, 0, loss * 0.18);
      if (flapRef?.current) flapRef.current.visible = rear.visible;
    }
  });
  return (
    <>
      <mesh
        geometry={damageRef ? geometry.paint : geometry.paintWithWings}
        material={material("paint", options)}
        castShadow={!ghost}
      />
      <mesh geometry={geometry.carbon} material={material("carbon", options)} castShadow={!ghost} />
      {damageRef && (
        <>
      <group ref={frontWingRef} position={FRONT_WING_PIVOT}>
        <mesh
          geometry={geometry.frontWing}
          material={material("paint", options)}
          position={[-FRONT_WING_PIVOT[0], -FRONT_WING_PIVOT[1], -FRONT_WING_PIVOT[2]]}
          castShadow={!ghost}
        />
      </group>
      <group ref={rearWingRef} position={REAR_WING_PIVOT}>
        <mesh
          geometry={geometry.rearWing}
          material={material("paint", options)}
          position={[-REAR_WING_PIVOT[0], -REAR_WING_PIVOT[1], -REAR_WING_PIVOT[2]]}
          castShadow={!ghost}
        />
      </group>
        </>
      )}
      <group ref={flapRef} position={FLAP_PIVOT}>
        <mesh
          rotation={[FLAP_CLOSED_INCLINE_RAD, 0, 0]}
          geometry={geometry.flap}
          material={material("paint", options)}
          castShadow={!ghost}
        />
      </group>
      {!ghost && raceNumber !== null && numberMaterial(raceNumber) && (
        <mesh geometry={numberGeometry} material={numberMaterial(raceNumber)!} position={[0, 0.66, 1.2]} />
      )}
      {!ghost && !studio && (
        <mesh geometry={rainLightGeometry} material={rainLightMaterial} position={[0, 0.2, 2.06]} />
      )}
    </>
  );
}

/**
 * The four wheels on the physics-owned stations. `steerRefs`/`spinRefs`
 * keep the exact group structure the vehicle controllers write to (see
 * Car.tsx / AICar.tsx); pass neither for parked wheels (the showroom).
 * `compoundRef` (the player's live 1/2/3 pick) swaps the sidewall stripe
 * colour without a re-render; without one the car runs mediums.
 */
export function SteeringWheel({
  wheelRef,
}: {
  wheelRef: React.RefObject<THREE.Group | null>;
}) {
  // A modern F1 wheel is a squared-off rectangular rim, not a thin car
  // steering-wheel torus: separate grips, a wide carbon frame, a small driver
  // display, colored buttons and rear paddle shifters make the rotation read
  // clearly from the helmet camera. Overall size comes from helmetView.ts, the
  // same constants the camera framing test measures against.
  const rimSpanX = STEERING_WHEEL_HALF_WIDTH * 2;
  const rimSpanY = STEERING_WHEEL_HALF_HEIGHT * 2;
  const gripThickness = rimSpanX * 0.14;
  const horizontalRim = useMemo(
    () => new RoundedBoxGeometry(rimSpanX - 0.02, rimSpanY * 0.18, 0.05, 3, 0.018),
    [rimSpanX, rimSpanY]
  );
  const grip = useMemo(
    () => new RoundedBoxGeometry(gripThickness, rimSpanY * 0.84, 0.058, 3, 0.022),
    [gripThickness, rimSpanY]
  );
  const spoke = useMemo(
    () => new RoundedBoxGeometry(rimSpanX * 0.07, rimSpanY * 0.68, 0.03, 2, 0.01),
    [rimSpanX, rimSpanY]
  );
  const hub = useMemo(
    () => new RoundedBoxGeometry(rimSpanX * 0.35, rimSpanY * 0.3, 0.055, 3, 0.02),
    [rimSpanX, rimSpanY]
  );
  const display = useMemo(
    () => new RoundedBoxGeometry(rimSpanX * 0.26, rimSpanY * 0.17, 0.014, 2, 0.006),
    [rimSpanX, rimSpanY]
  );
  const button = useMemo(() => {
    const geometry = new THREE.CylinderGeometry(0.012, 0.012, 0.016, 8);
    geometry.rotateX(Math.PI / 2);
    return geometry;
  }, []);
  const paddle = useMemo(
    () => new RoundedBoxGeometry(rimSpanX * 0.08, rimSpanY * 0.42, 0.02, 2, 0.008),
    [rimSpanX, rimSpanY]
  );
  const buttonPositions: [number, number, string][] = [
    [-rimSpanX * 0.21, rimSpanY * 0.14, "#e10600"],
    [-rimSpanX * 0.11, rimSpanY * 0.14, "#ffd23f"],
    [rimSpanX * 0.11, rimSpanY * 0.14, "#39ff88"],
    [rimSpanX * 0.21, rimSpanY * 0.14, "#6bd1ff"],
    [-rimSpanX * 0.21, -rimSpanY * 0.08, "#6bd1ff"],
    [rimSpanX * 0.21, -rimSpanY * 0.08, "#e10600"],
  ];
  const gripX = rimSpanX / 2 - gripThickness / 2;
  const rimY = rimSpanY / 2 - rimSpanY * 0.09;

  return (
    <group
      ref={wheelRef}
      position={[0, STEERING_WHEEL_CENTER_Y, STEERING_WHEEL_CENTER_Z]}
      visible={false}
    >
      <mesh geometry={horizontalRim} position={[0, rimY, 0]} castShadow>
        <meshStandardMaterial color="#20252c" roughness={0.52} metalness={0.32} />
      </mesh>
      <mesh geometry={horizontalRim} position={[0, -rimY, 0]} castShadow>
        <meshStandardMaterial color="#20252c" roughness={0.52} metalness={0.32} />
      </mesh>
      <mesh geometry={grip} position={[-gripX, 0, 0]} rotation={[0, 0, -0.1]} castShadow>
        <meshStandardMaterial color="#101216" roughness={0.86} metalness={0.05} />
      </mesh>
      <mesh geometry={grip} position={[gripX, 0, 0]} rotation={[0, 0, 0.1]} castShadow>
        <meshStandardMaterial color="#101216" roughness={0.86} metalness={0.05} />
      </mesh>
      <mesh
        geometry={spoke}
        position={[-rimSpanX * 0.13, 0, 0.006]}
        rotation={[0, 0, -0.08]}
        castShadow
      >
        <meshStandardMaterial color="#454d59" roughness={0.4} metalness={0.45} />
      </mesh>
      <mesh
        geometry={spoke}
        position={[rimSpanX * 0.13, 0, 0.006]}
        rotation={[0, 0, 0.08]}
        castShadow
      >
        <meshStandardMaterial color="#454d59" roughness={0.4} metalness={0.45} />
      </mesh>
      <mesh geometry={hub} position={[0, 0, 0.018]} castShadow>
        <meshStandardMaterial color="#0b0d10" roughness={0.34} metalness={0.55} />
      </mesh>
      <mesh geometry={display} position={[0, rimSpanY * 0.21, 0.052]} castShadow>
        <meshStandardMaterial
          color="#0b1c2c"
          emissive="#0b3550"
          emissiveIntensity={0.7}
          roughness={0.22}
          metalness={0.15}
        />
      </mesh>
      {buttonPositions.map(([x, y, color]) => (
        <mesh key={`${x}-${y}`} geometry={button} position={[x, y, 0.055]} castShadow>
          <meshStandardMaterial color={color} roughness={0.35} metalness={0.2} />
        </mesh>
      ))}
      <mesh geometry={paddle} position={[-rimSpanX * 0.325, 0, -0.045]} castShadow>
        <meshStandardMaterial color="#1a1e24" roughness={0.6} metalness={0.3} />
      </mesh>
      <mesh geometry={paddle} position={[rimSpanX * 0.325, 0, -0.045]} castShadow>
        <meshStandardMaterial color="#1a1e24" roughness={0.6} metalness={0.3} />
      </mesh>
    </group>
  );
}

export function HelmetCockpit({
  interiorRef,
}: {
  interiorRef: React.RefObject<THREE.Group | null>;
}) {
  // Cockpit furniture the sculpted shell can't provide from the driver's own
  // eye point: the shell is a closed surface, so only the nose, halo, mirror
  // housings and wheels read from inside it. The dash and side rails are
  // placed relative to the same wheel constants the camera framing test uses.
  const dashWidth = STEERING_WHEEL_HALF_WIDTH * 2.5;
  const dash = useMemo(
    () => new RoundedBoxGeometry(dashWidth, 0.07, 0.16, 3, 0.025),
    [dashWidth]
  );
  const rail = useMemo(() => new RoundedBoxGeometry(0.045, 0.2, 0.3, 3, 0.018), []);
  const railX = STEERING_WHEEL_HALF_WIDTH + 0.045;
  return (
    <group ref={interiorRef} visible={false}>
      <mesh
        geometry={dash}
        position={[0, STEERING_WHEEL_CENTER_Y - 0.1, STEERING_WHEEL_CENTER_Z - 0.12]}
        rotation={[-0.16, 0, 0]}
        castShadow
      >
        <meshStandardMaterial color="#101318" roughness={0.62} metalness={0.28} />
      </mesh>
      <mesh
        geometry={rail}
        position={[-railX, STEERING_WHEEL_CENTER_Y, STEERING_WHEEL_CENTER_Z - 0.02]}
        rotation={[0, 0, -0.08]}
        castShadow
      >
        <meshStandardMaterial color="#171b21" roughness={0.55} metalness={0.35} />
      </mesh>
      <mesh
        geometry={rail}
        position={[railX, STEERING_WHEEL_CENTER_Y, STEERING_WHEEL_CENTER_Z - 0.02]}
        rotation={[0, 0, 0.08]}
        castShadow
      >
        <meshStandardMaterial color="#171b21" roughness={0.55} metalness={0.35} />
      </mesh>
    </group>
  );
}

export function CarWheels({
  steerRefs,
  spinRefs,
  compoundRef,
  ghost = false,
  studio = false,
}: {
  steerRefs?: React.RefObject<(THREE.Group | null)[]>;
  spinRefs?: React.RefObject<(THREE.Group | null)[]>;
  compoundRef?: React.RefObject<TireCompoundId>;
  ghost?: boolean;
  studio?: boolean;
}) {
  const { cheapMaterials: cheap } = useQuality();
  const rubber = material("rubber", { ghost, studio, cheap });
  const meshRefs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(() => {
    if (!compoundRef) return;
    const want = wheels(compoundRef.current ?? "medium");
    for (const mesh of meshRefs.current) if (mesh && mesh.geometry !== want) mesh.geometry = want;
  });
  return (
    <>
      {CAR_WHEELS.map((wheel, i) => (
        <group key={`wheel-${i}`} position={wheel.position}>
          <group ref={steerRefs ? (el) => { steerRefs.current[i] = el; } : undefined}>
            <group ref={spinRefs ? (el) => { spinRefs.current[i] = el; } : undefined}>
              <mesh
                ref={(el) => {
                  meshRefs.current[i] = el;
                }}
                geometry={wheels("medium")}
                material={rubber}
                castShadow={!ghost}
              />
            </group>
          </group>
        </group>
      ))}
    </>
  );
}
