"use client";

import * as THREE from "three";
import { useQuality } from "./renderQuality";
import { CAR_WHEELS, CHASSIS_HALF_EXTENTS } from "@/lib/physics/vehicle";
import {
  FLAP_CLOSED_INCLINE_RAD,
  computeAccentColor,
  computeF1BodyPanels,
  mergePanelBoxes,
  type BodyPanel,
  type BodyPanelColor,
  type F1BodyGeometry,
} from "@/lib/race/carBody";

// Shared renderer for the car body (see lib/race/carBody.ts for the panels
// themselves): the player's car, the ghost, every AI rival, every remote
// car and the garage showroom all draw this same shell, so the work here is
// about doing it once. Everything three.js owns - the merged box buffers,
// the primitive shapes, the materials - is built on first use and cached at
// module scope: a 21-car grid shares ten geometries and one material per
// paint instead of ~90 meshes and materials per car.

/** Paddock neutrals: every team reads as the same machinery in different
 * paint (livery/accent come from the caller). */
const NEUTRAL_COLORS: Partial<Record<BodyPanelColor, string>> = {
  carbon: "#161616",
  helmet: "#ededed",
  visor: "#101418",
  tire: "#131313",
  rim: "#8f9296",
  light: "#ff2222",
};

/** Surface finish per role: paint is glossier than carbon, the rain light
 * glows, tire rubber is matte. Studio (garage showroom) lifts paint a touch
 * and gives carbon a little more sheen under the studio lights. */
const ROLE_FINISH: Record<
  BodyPanelColor,
  { roughness: number; metalness: number; emissive?: string; emissiveIntensity?: number }
> = {
  livery: { roughness: 0.34, metalness: 0.28 },
  accent: { roughness: 0.3, metalness: 0.32 },
  carbon: { roughness: 0.55, metalness: 0.45 },
  helmet: { roughness: 0.34, metalness: 0.12 },
  visor: { roughness: 0.16, metalness: 0.6 },
  tire: { roughness: 0.95, metalness: 0 },
  rim: { roughness: 0.3, metalness: 0.8 },
  light: { roughness: 0.4, metalness: 0, emissive: "#ff2222", emissiveIntensity: 0.9 },
};

/** Merged paint roles, in draw order - one mesh each. Helmet, halo, tires
 * and rims are primitive shapes and live outside this list. */
const MERGED_ROLES: BodyPanelColor[] = ["carbon", "livery", "accent", "visor", "light"];

const TIRE_SEGMENTS = 20;
const RIM_SEGMENTS = 12;
// Matches the visual tire width both cars always shipped (the physics wheel
// has no width of its own - see CAR_WHEELS).
const TIRE_WIDTH_METERS = 0.28;
// Rim disc: smaller radius, slightly wider than the tire, so its faces sit
// proud of the sidewalls and read from any angle.
const RIM_RADIUS_FRACTION = 0.55;
const RIM_WIDTH_EXTRA = 0.02;

interface CarBodyParts {
  /** Static panels grouped by paint role, in MERGED_ROLES order. */
  groups: { color: BodyPanelColor; panels: BodyPanel[] }[];
  flap: BodyPanel | null;
  helmet: F1BodyGeometry["helmet"];
  halo: F1BodyGeometry["halo"];
}

let parts: CarBodyParts | null = null;

/** The panel list and its role grouping, computed once for the whole app:
 * the inputs are compile-time constants, so every car shares them. */
function carBodyParts(): CarBodyParts {
  if (!parts) {
    const body = computeF1BodyPanels(
      CHASSIS_HALF_EXTENTS,
      CAR_WHEELS.map((w) => ({ x: w.position[0], z: w.position[2] }))
    );
    parts = {
      groups: MERGED_ROLES.map((color) => ({
        color,
        // The flap is excluded: it is the one panel that moves, so it stays
        // its own mesh inside the pivot group below.
        panels: body.panels.filter((panel) => panel.color === color && !panel.flap),
      })).filter((group) => group.panels.length > 0),
      flap: body.panels.find((panel) => panel.flap) ?? null,
      helmet: body.helmet,
      halo: body.halo,
    };
  }
  return parts;
}

const geometryCache = new Map<string, THREE.BufferGeometry>();
const materialCache = new Map<string, THREE.Material>();

/** Cached-by-key geometry factory: every distinct shape in the game is built
 * exactly once, however many cars ask for it. */
function cachedGeometry(key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const geometry = build();
  geometry.computeBoundingSphere();
  geometryCache.set(key, geometry);
  return geometry;
}

/** One static mesh per paint role: the role's boxes merged into a single
 * buffer (see mergePanelBoxes). Keyed by role, not by car, so the whole grid
 * shares the same GPU buffers. */
function mergedGeometryFor(color: BodyPanelColor): THREE.BufferGeometry {
  return cachedGeometry(`boxes:${color}`, () => {
    const group = carBodyParts().groups.find((candidate) => candidate.color === color);
    const { positions, normals, indices } = mergePanelBoxes(group ? group.panels : []);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return geometry;
  });
}

function neutralColor(role: BodyPanelColor): string {
  return NEUTRAL_COLORS[role] ?? "#161616";
}

/** Resolves the paint for a role: the caller's livery/accent, or the fixed
 * paddock neutrals for carbon/visor/light/helmet/tire/rim. */
function paintFor(role: BodyPanelColor, bodyColor: string, accentColor?: string): string {
  if (role === "livery") return bodyColor;
  if (role === "accent") return accentColor ?? computeAccentColor(bodyColor);
  return neutralColor(role);
}

/** One material per (role, paint, solid/ghost, race/studio) combination -
 * materials compile shaders, so sharing them across the grid (rather than
 * per-car declarative JSX) is the bigger win than sharing buffers. */
function carMaterial(
  role: BodyPanelColor,
  paint: string,
  options: { ghost?: boolean; studio?: boolean; cheap?: boolean } = {}
): THREE.Material {
  const ghost = options.ghost ?? false;
  const studio = options.studio ?? false;
  const cheap = options.cheap ?? false;
  const key = `${role}|${paint}|${ghost ? "ghost" : "solid"}|${studio ? "studio" : "race"}|${cheap ? "lambert" : "pbr"}`;
  const cached = materialCache.get(key);
  if (cached) return cached;
  const finish = ROLE_FINISH[role];
  if (cheap) {
    // Low graphics tier (see lib/render/quality.ts): Lambert, no PBR.
    const lambert = new THREE.MeshLambertMaterial({
      color: paint,
      emissive: new THREE.Color(finish.emissive ?? "#000000"),
      emissiveIntensity: finish.emissiveIntensity ?? 0,
      transparent: ghost,
      opacity: ghost ? 0.35 : 1,
      depthWrite: !ghost,
    });
    materialCache.set(key, lambert);
    return lambert;
  }
  const material = new THREE.MeshStandardMaterial({
    color: paint,
    roughness: studio ? Math.max(0.05, finish.roughness - 0.06) : finish.roughness,
    metalness: studio ? Math.min(1, finish.metalness + 0.06) : finish.metalness,
    emissive: new THREE.Color(finish.emissive ?? "#000000"),
    emissiveIntensity: finish.emissiveIntensity ?? 0,
    transparent: ghost,
    opacity: ghost ? 0.35 : 1,
    depthWrite: !ghost,
  });
  materialCache.set(key, material);
  return material;
}

/**
 * The body shell: merged static panels, the DRS flap in its pivot group, the
 * helmet and the halo ring. `flapRef` is the pivot the owner animates (see
 * Car.tsx); without one the flap simply stays parked shut, which is what the
 * AI, the remote cars and the showroom want.
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
  const { groups, flap, helmet, halo } = carBodyParts();
  const material = (role: BodyPanelColor) =>
    carMaterial(role, paintFor(role, bodyColor, accentColor), { ghost, studio, cheap });
  return (
    <>
      {groups.map((group) => (
        <mesh
          key={group.color}
          geometry={mergedGeometryFor(group.color)}
          material={material(group.color)}
          castShadow={!ghost}
        />
      ))}
      {flap && (
        <group
          ref={flapRef}
          position={[flap.position[0], flap.position[1], flap.position[2] - flap.size[2] / 2]}
        >
          <mesh
            position={[0, 0, flap.size[2] / 2]}
            rotation={[FLAP_CLOSED_INCLINE_RAD, 0, 0]}
            geometry={cachedGeometry(`box:${flap.size.join(":")}`, () =>
              new THREE.BoxGeometry(...flap.size)
            )}
            material={material(flap.color)}
            castShadow={!ghost}
          />
        </group>
      )}
      <mesh
        position={helmet.position}
        geometry={cachedGeometry(`sphere:${helmet.radius}`, () =>
          new THREE.SphereGeometry(helmet.radius, 16, 12)
        )}
        material={material("helmet")}
        castShadow={!ghost}
      />
      <mesh
        position={halo.position}
        rotation={[Math.PI / 2, 0, 0]}
        geometry={cachedGeometry(`torus:${halo.radius}:${halo.tube}`, () =>
          new THREE.TorusGeometry(halo.radius, halo.tube, 8, 24)
        )}
        material={material("carbon")}
        castShadow={!ghost}
      />
    </>
  );
}

/**
 * The four wheels on the physics-owned stations, dressed as tire + rim.
 * `steerRefs`/`spinRefs` keep the exact group structure the vehicle
 * controllers write to (see Car.tsx / AICar.tsx); pass neither for parked
 * wheels (the showroom).
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
  return (
    <>
      {CAR_WHEELS.map((wheel, i) => (
        <group key={`wheel-${i}`} position={wheel.position}>
          <group ref={steerRefs ? (el) => { steerRefs.current[i] = el; } : undefined}>
            <group ref={spinRefs ? (el) => { spinRefs.current[i] = el; } : undefined}>
              <mesh
                rotation={[0, 0, Math.PI / 2]}
                geometry={cachedGeometry(
                  `cyl:${wheel.radius}:${TIRE_WIDTH_METERS}:${TIRE_SEGMENTS}`,
                  () => new THREE.CylinderGeometry(wheel.radius, wheel.radius, TIRE_WIDTH_METERS, TIRE_SEGMENTS)
                )}
                material={carMaterial("tire", neutralColor("tire"), { ghost, studio, cheap })}
                castShadow={!ghost}
              />
              <mesh
                rotation={[0, 0, Math.PI / 2]}
                geometry={cachedGeometry(
                  `cyl:${wheel.radius * RIM_RADIUS_FRACTION}:${TIRE_WIDTH_METERS + RIM_WIDTH_EXTRA}:${RIM_SEGMENTS}`,
                  () =>
                    new THREE.CylinderGeometry(
                      wheel.radius * RIM_RADIUS_FRACTION,
                      wheel.radius * RIM_RADIUS_FRACTION,
                      TIRE_WIDTH_METERS + RIM_WIDTH_EXTRA,
                      RIM_SEGMENTS
                    )
                )}
                material={carMaterial("rim", neutralColor("rim"), { ghost, studio, cheap })}
                castShadow={!ghost}
              />
            </group>
          </group>
        </group>
      ))}
    </>
  );
}
