"use client";

import { useMemo } from "react";
import type * as THREE from "three";
import { CAR_WHEELS, CHASSIS_HALF_EXTENTS } from "@/lib/physics/vehicle";
import { computeF1BodyPanels, type BodyPanelColor } from "@/lib/race/carBody";

// Flat part colors. Livery comes from the garage pick (bodyColor); the rest
// are fixed paddock neutrals, so every team reads as the same machinery in
// different paint.
const PART_COLORS: Record<Exclude<BodyPanelColor, "livery">, string> = {
  carbon: "#161616",
  helmet: "#ededed",
  visor: "#101418",
  tire: "#131313",
  rim: "#8f9296",
  light: "#ff2222",
};

const TIRE_SEGMENTS = 20;
const RIM_SEGMENTS = 12;
// Matches the visual tire width both cars always shipped (the physics wheel
// has no width of its own - see CAR_WHEELS).
const TIRE_WIDTH_METERS = 0.28;
// Rim disc: smaller radius, slightly wider than the tire, so its faces sit
// proud of the sidewalls and read from any angle.
const RIM_RADIUS_FRACTION = 0.55;
const RIM_WIDTH_EXTRA = 0.02;

/**
 * The F1 car visual shared by the player (Car.tsx) and the AI opponent
 * (AICar.tsx): one low-poly body built from computeF1BodyPanels plus
 * dressed wheels on the physics-owned stations. Visual only - the solid
 * colliders stay the chassis cuboid and the mesh-less raycast wheels (see
 * the colliders={false} comment in Car.tsx), and the steer/spin animation
 * groups keep their exact structure, so handling is untouched.
 */
export function F1CarBody({
  bodyColor,
  steerRefs,
  spinRefs,
  flapRef,
}: {
  bodyColor: string;
  steerRefs: React.RefObject<(THREE.Group | null)[]>;
  spinRefs: React.RefObject<(THREE.Group | null)[]>;
  /** Animated by the owner (see Car.tsx): rotates the rear-wing flap open
   * in low-drag mode. Absent, the flap sits shut - the AI never deploys. */
  flapRef?: React.RefObject<THREE.Group | null>;
}) {
  const body = useMemo(
    () =>
      computeF1BodyPanels(
        CHASSIS_HALF_EXTENTS,
        CAR_WHEELS.map((w) => ({ x: w.position[0], z: w.position[2] }))
      ),
    []
  );
  const colorFor = (color: BodyPanelColor): string =>
    color === "livery" ? bodyColor : PART_COLORS[color];
  const statics = body.panels.filter((p) => !p.flap);
  const flap = body.panels.find((p) => p.flap);

  return (
    <>
      {statics.map((panel, i) => (
        <mesh
          key={`panel-${i}`}
          position={panel.position}
          castShadow
        >
          <boxGeometry args={panel.size} />
          <meshStandardMaterial color={colorFor(panel.color)} />
        </mesh>
      ))}
      {flap && (
        <group
          ref={flapRef}
          position={[flap.position[0], flap.position[1], flap.position[2] - flap.size[2] / 2]}
        >
          <mesh position={[0, 0, flap.size[2] / 2]} castShadow>
            <boxGeometry args={flap.size} />
            <meshStandardMaterial color={colorFor(flap.color)} />
          </mesh>
        </group>
      )}
      <mesh position={body.helmet.position} castShadow>
        <sphereGeometry args={[body.helmet.radius, 16, 12]} />
        <meshStandardMaterial color={colorFor("helmet")} />
      </mesh>
      <mesh position={body.halo.position} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <torusGeometry args={[body.halo.radius, body.halo.tube, 8, 24]} />
        <meshStandardMaterial color={colorFor("carbon")} />
      </mesh>
      {CAR_WHEELS.map((wheel, i) => (
        <group key={`wheel-${i}`} position={wheel.position}>
          <group ref={(el) => { steerRefs.current[i] = el; }}>
            <group ref={(el) => { spinRefs.current[i] = el; }}>
              <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry args={[wheel.radius, wheel.radius, TIRE_WIDTH_METERS, TIRE_SEGMENTS]} />
                <meshStandardMaterial color={colorFor("tire")} />
              </mesh>
              <mesh rotation={[0, 0, Math.PI / 2]} castShadow>
                <cylinderGeometry
                  args={[
                    wheel.radius * RIM_RADIUS_FRACTION,
                    wheel.radius * RIM_RADIUS_FRACTION,
                    TIRE_WIDTH_METERS + RIM_WIDTH_EXTRA,
                    RIM_SEGMENTS,
                  ]}
                />
                <meshStandardMaterial color={colorFor("rim")} />
              </mesh>
            </group>
          </group>
        </group>
      ))}
    </>
  );
}
