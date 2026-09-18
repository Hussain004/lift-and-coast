"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame } from "@react-three/fiber";
import { CAR_WHEELS, CHASSIS_HALF_EXTENTS } from "@/lib/physics/vehicle";
import { computeF1BodyPanels, type BodyPanelColor } from "@/lib/race/carBody";
import { computeDriverFigure, type FigureColor } from "@/lib/race/driverFigure";
import {
  resolveRosterSelection,
  useRosterSelection,
  type RosterDriver,
  type RosterTeam,
} from "@/lib/race/roster";

// Garage showroom hero: the selected car in full livery next to its driver,
// on a slow turntable under studio lights. Drag sideways to spin it by
// hand; auto-rotate resumes a couple of seconds after release. Pure menu
// scenery - no physics, no colliders, shadows off for a cheap frame.
const AUTO_SPEED_RAD_S = 0.45;
const RESUME_DELAY_S = 2.5;

function partColor(
  color: BodyPanelColor,
  team: RosterTeam
): string {
  if (color === "livery") return team.primaryColor;
  return {
    carbon: "#161616",
    helmet: "#ededed",
    visor: "#101418",
    tire: "#131313",
    rim: "#8f9296",
    light: "#ff2222",
  }[color];
}

function figureColor(
  color: FigureColor,
  team: RosterTeam,
  driver: RosterDriver
): string {
  switch (color) {
    case "suit":
      return team.primaryColor;
    case "trim":
      return team.secondaryColor;
    case "helmet":
      return driver.helmet;
    case "visor":
      return driver.visor;
    case "carbon":
      return "#161616";
  }
}

function Turntable({ team, driver }: { team: RosterTeam; driver: RosterDriver }) {
  const group = useRef<THREE.Group>(null);
  // Seconds until auto-rotate resumes after a hand spin.
  const cooldown = useRef(0);
  const dragging = useRef(false);
  const lx = useRef(0);

  const body = useMemo(
    () =>
      computeF1BodyPanels(
        CHASSIS_HALF_EXTENTS,
        CAR_WHEELS.map((w) => ({ x: w.position[0], z: w.position[2] }))
      ),
    []
  );
  const figure = useMemo(() => computeDriverFigure(), []);
  const statics = body.panels.filter((p) => !p.flap);
  const flap = body.panels.find((p) => p.flap);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    cooldown.current = Math.max(0, cooldown.current - Math.min(dt, 0.05));
    if (cooldown.current <= 0) {
      g.rotation.y += AUTO_SPEED_RAD_S * Math.min(dt, 0.05);
    }
  });

  // Window-level move/up so a fast drag off the canvas doesn't stick, same
  // pattern as the orbit camera (see app/race/Scene.tsx).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current || !group.current) return;
      group.current.rotation.y += (e.clientX - lx.current) * 0.008;
      lx.current = e.clientX;
      cooldown.current = RESUME_DELAY_S;
    };
    const up = () => {
      dragging.current = false;
      cooldown.current = RESUME_DELAY_S;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  return (
    <group
      ref={group}
      onPointerDown={(e) => {
        dragging.current = true;
        lx.current = e.clientX;
        cooldown.current = RESUME_DELAY_S;
      }}
    >
      {/* Car, shut flap parked. */}
      {statics.map((panel, i) => (
        <mesh key={`panel-${i}`} position={panel.position}>
          <boxGeometry args={panel.size} />
          <meshStandardMaterial color={partColor(panel.color, team)} roughness={0.45} metalness={0.25} />
        </mesh>
      ))}
      {flap && (
        <group position={[flap.position[0], flap.position[1], flap.position[2] - flap.size[2] / 2]}>
          <mesh position={[0, 0, flap.size[2] / 2]}>
            <boxGeometry args={flap.size} />
            <meshStandardMaterial color={partColor(flap.color, team)} roughness={0.45} metalness={0.25} />
          </mesh>
        </group>
      )}
      <mesh position={body.helmet.position}>
        <sphereGeometry args={[body.helmet.radius, 16, 12]} />
        <meshStandardMaterial color={partColor("helmet", team)} roughness={0.4} metalness={0.2} />
      </mesh>
      <mesh position={body.halo.position} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[body.halo.radius, body.halo.tube, 8, 24]} />
        <meshStandardMaterial color={partColor("carbon", team)} roughness={0.5} metalness={0.3} />
      </mesh>
      {CAR_WHEELS.map((wheel, i) => (
        <group key={`wheel-${i}`} position={wheel.position}>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[wheel.radius, wheel.radius, 0.28, 20]} />
            <meshStandardMaterial color={partColor("tire", team)} roughness={0.9} />
          </mesh>
          <mesh rotation={[0, 0, Math.PI / 2]}>
            <cylinderGeometry args={[wheel.radius * 0.55, wheel.radius * 0.55, 0.3, 12]} />
            <meshStandardMaterial color={partColor("rim", team)} roughness={0.35} metalness={0.6} />
          </mesh>
        </group>
      ))}
      {/* Driver figure at the car's left flank, feet on the plinth.
          Wheel bottoms sit at y=-0.69 in body frame, so that is ground. */}
      <group position={[-1.7, -0.69, 0.2]}>
        {figure.panels.map((panel, i) => (
          <mesh key={`fig-${i}`} position={panel.position}>
            <boxGeometry args={panel.size} />
            <meshStandardMaterial color={figureColor(panel.color, team, driver)} roughness={0.6} />
          </mesh>
        ))}
        <mesh position={figure.helmet.position}>
          <sphereGeometry args={[figure.helmet.radius, 16, 12]} />
          <meshStandardMaterial color={figureColor("helmet", team, driver)} roughness={0.35} metalness={0.15} />
        </mesh>
      </group>
      {/* Plinth disc with a team-color ring. */}
      <mesh position={[0, -0.69, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.4, 48]} />
        <meshStandardMaterial color="#101216" roughness={0.65} metalness={0} />
      </mesh>
      <mesh position={[0, -0.685, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[3.5, 3.58, 64]} />
        <meshBasicMaterial color={team.primaryColor} />
      </mesh>
    </group>
  );
}

export function Showroom({ team, driver }: { team: RosterTeam; driver: RosterDriver }) {
  return (
    <Canvas
      dpr={[1, 1.5]}
      camera={{ position: [4.6, 2.1, 6.4], fov: 38 }}
      gl={{ antialias: true, alpha: true }}
      style={{ touchAction: "pan-y" }}
      onCreated={({ camera }) => camera.lookAt(0, 0.15, 0)}
    >
      <ambientLight intensity={0.5} />
      <directionalLight position={[5, 8, 4]} intensity={1.4} color="#ffffff" />
      <directionalLight position={[-6, 3, -5]} intensity={0.55} color="#7aa2ff" />
      <Turntable team={team} driver={driver} />
    </Canvas>
  );
}

/** Home-page hero: resolves the live garage pick and stages it. Imported
 * with ssr:false (see app/page.tsx) so three.js never touches prerender. */
export function ShowroomPanel() {
  const { teamId, driverCode } = useRosterSelection();
  const { team, driver } = resolveRosterSelection(teamId, driverCode);
  return <Showroom team={team} driver={driver} />;
}
