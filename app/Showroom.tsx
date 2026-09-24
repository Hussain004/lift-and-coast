"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { ContactShadows, Sparkles } from "@react-three/drei";
import { CarBodyShell, CarWheels } from "./race/CarBodyMesh";
import {
  resolveRosterSelection,
  useRosterSelection,
  type RosterTeam,
} from "@/lib/race/roster";

// Garage showroom hero: the selected car in full livery on a slow turntable under studio lights. Drag sideways to spin it by
// hand; auto-rotate resumes a couple of seconds after release. Pure menu
// scenery - no physics, no colliders, shadows off for a cheap frame.
const AUTO_SPEED_RAD_S = 0.45;
const RESUME_DELAY_S = 2.5;

function Turntable({ team, reduced }: { team: RosterTeam; reduced: boolean }) {
  const group = useRef<THREE.Group>(null);
  // Accumulated spin so a hand drag can hand off momentum: the drag writes
  // rot + a velocity, and the release lets it decay before auto-rotate
  // resumes after a couple of seconds.
  const rot = useRef(-0.55);
  const vel = useRef(0);
  const dragging = useRef(false);
  const lx = useRef(0);
  const lastInput = useRef(RESUME_DELAY_S);
  const float = useRef(0);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const d = Math.min(dt, 0.05);
    if (!dragging.current) {
      if (Math.abs(vel.current) > 0.0002) {
        rot.current += vel.current;
        vel.current *= 0.93;
        lastInput.current = 0;
      } else {
        lastInput.current += d;
        if (lastInput.current >= RESUME_DELAY_S && !reduced) {
          rot.current += AUTO_SPEED_RAD_S * d;
        }
      }
    }
    g.rotation.y = rot.current;
    // Gentle bob so the car reads as alive, not as a screenshot.
    if (!reduced) {
      float.current += d;
      g.position.y = Math.sin(float.current * 0.9) * 0.05;
    }
  });

  // Window-level move/up so a fast drag off the canvas doesn't stick, same
  // pattern as the orbit camera (see app/race/Scene.tsx).
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (!dragging.current) return;
      const dx = e.clientX - lx.current;
      lx.current = e.clientX;
      rot.current += dx * 0.008;
      vel.current = dx * 0.008;
      lastInput.current = 0;
    };
    const up = () => {
      dragging.current = false;
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
        vel.current = 0;
        lastInput.current = RESUME_DELAY_S;
      }}
    >
      {/* Car in full livery, active-aero flap parked shut: the same shell every car
          on the grid draws (see app/race/CarBodyMesh.tsx), in studio finish
          and with the pick's secondary color as the stripe accent. */}
      <CarBodyShell
        bodyColor={team.primaryColor}
        accentColor={team.secondaryColor}
        studio
      />
      <CarWheels studio />
      {/* Plinth disc with a team-color ring + faint outer rim, plus a
          team-colored underglow pooling beneath the car. */}
      <mesh position={[0, -0.69, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.4, 48]} />
        <meshStandardMaterial color="#101216" roughness={0.65} metalness={0} />
      </mesh>
      <mesh position={[0, -0.685, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[3.5, 3.58, 64]} />
        <meshBasicMaterial color={team.primaryColor} />
      </mesh>
      <mesh position={[0, -0.684, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[4.25, 4.31, 64]} />
        <meshBasicMaterial color="#f4f1e8" transparent opacity={0.14} />
      </mesh>
      <pointLight
        position={[0, -0.35, 0]}
        color={team.primaryColor}
        intensity={22}
        distance={5.5}
        decay={1.8}
      />
    </group>
  );
}

/** Pointer parallax: the studio camera leans toward the cursor for a
 * physical, "under glass" feel without taking control from the user. */
function CameraRig() {
  const { camera, pointer } = useThree();
  const target = useRef(new THREE.Vector3());
  useFrame(() => {
    target.current.set(3.7 + pointer.x * 0.6, 1.45 + pointer.y * 0.3, 4.8);
    camera.position.lerp(target.current, 0.045);
    camera.lookAt(0, -0.12, 0);
  });
  return null;
}

export function Showroom({
  team,
  visible = true,
  reduced = false,
}: {
  team: RosterTeam;
  /** Frame loop gate - false pauses all rendering (offscreen saving). */
  visible?: boolean;
  reduced?: boolean;
}) {
  return (
    <Canvas
      frameloop={visible ? "always" : "never"}
      dpr={[1, 1.5]}
      camera={{ position: [3.7, 1.45, 4.8], fov: 36 }}
      gl={{ antialias: true, alpha: true }}
      style={{ touchAction: "pan-y" }}
      onCreated={({ camera }) => camera.lookAt(0, -0.12, 0)}
    >
      {/* Three-point rig: warm key, cool rim, gold kicker from behind. */}
      <ambientLight intensity={0.35} />
      <directionalLight position={[5, 8, 4]} intensity={1.5} color="#fff1dd" />
      <directionalLight position={[-6, 3, -5]} intensity={0.8} color="#7aa2ff" />
      <directionalLight position={[0, 5, -8]} intensity={0.5} color="#d3ab63" />
      <ContactShadows
        position={[0, -0.688, 0]}
        scale={13}
        blur={2.4}
        far={2.2}
        opacity={0.55}
        resolution={256}
        color="#000000"
      />
      <Sparkles
        count={40}
        scale={[10, 3.4, 10]}
        position={[0, 0.9, 0]}
        size={2}
        speed={0.22}
        opacity={0.4}
        color="#d3ab63"
      />
      <CameraRig />
      <Turntable team={team} reduced={reduced} />
    </Canvas>
  );
}

/** Home-page hero: resolves the live garage pick and stages it. Imported
 * with ssr:false (see app/ShowroomLoader.tsx) so three.js never touches
 * prerender, and wrapped so the loop pauses when scrolled away. */
export function ShowroomPanel() {
  const { teamId, driverCode } = useRosterSelection();
  const { team } = resolveRosterSelection(teamId, driverCode);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onMq = () => setReduced(mq.matches);
    mq.addEventListener("change", onMq);
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => setVisible(entries[0]?.isIntersecting ?? true),
        { threshold: 0.02 }
      );
      io.observe(el);
    }
    return () => {
      mq.removeEventListener("change", onMq);
      io?.disconnect();
    };
  }, []);

  return (
    <div ref={ref} style={{ position: "absolute", inset: 0 }}>
      <Showroom team={team} visible={visible} reduced={reduced} />
    </div>
  );
}
