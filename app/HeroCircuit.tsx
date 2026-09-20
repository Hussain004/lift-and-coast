"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Grid, Sparkles } from "@react-three/drei";
import { getOutline } from "@/lib/tracks/preview";
import { useSessionTrackId } from "@/lib/race/sessionSetup";
import { resolveRosterSelection, useRosterSelection } from "@/lib/race/roster";

// Hero centerpiece: the selected circuit's real outline (the same
// stride-sampled sidecar the world map draws - see lib/tracks/preview.ts)
// as a glowing asphalt ribbon floating over an infinite grid. A team-
// colored light pulse laps it; picking a pin redraws the ribbon with a
// draw-on sweep, picking a team retints the pulse - the hero is a live
// readout of the session setup, not a static logo. Drag spins it, the
// camera drifts with the pointer, and the loop pauses offscreen. Pure
// menu scenery: no physics, no shadow maps, a cheap frame.

const TRACK_SPAN = 34; // world units the fitted circuit spans
const RIBBON_WIDTH = 1.7;
const DRAW_SECONDS = 1.2; // draw-on sweep per track pick
const LAP_SECONDS = 9; // one pulse lap
const AUTO_SPEED = 0.05; // idle spin, rad/s
const DRAG_GAIN = 0.0042; // px -> radians
const INERTIA_DAMPING = 0.92;

interface CircuitData {
  points: THREE.Vector2[]; // centered, scaled; .y holds the world Z
  n: number;
}

interface SpinState {
  rot: number;
  vel: number;
  lx: number;
  dragging: boolean;
}

function normalizedCircuit(id: string): CircuitData {
  const outline = getOutline(id);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of outline.points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const cx = (minX + maxX) / 2;
  const cz = (minZ + maxZ) / 2;
  const scale = TRACK_SPAN / Math.max(maxX - minX, maxZ - minZ, 1e-9);
  return {
    points: outline.points.map(
      ([x, z]) => new THREE.Vector2((x - cx) * scale, (z - cz) * scale)
    ),
    n: outline.points.length,
  };
}

/** Closed-loop flat ribbon: two rows of verts offset along each point's
 * perpendicular, strip-indexed. DoubleSide materials, so winding is moot. */
function ribbonGeometry(points: THREE.Vector2[], width: number): THREE.BufferGeometry {
  const n = points.length;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const next = points[(i + 1) % n];
    const dx = next.x - prev.x;
    const dz = next.y - prev.y;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const p = points[i];
    positions[i * 6] = p.x + (nx * width) / 2;
    positions[i * 6 + 1] = 0;
    positions[i * 6 + 2] = p.y + (nz * width) / 2;
    positions[i * 6 + 3] = p.x - (nx * width) / 2;
    positions[i * 6 + 4] = 0;
    positions[i * 6 + 5] = p.y - (nz * width) / 2;
  }
  const indices: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = ((i + 1) % n) * 2;
    const d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

function sampleAt(points: THREE.Vector2[], t: number, out: THREE.Vector3): void {
  const n = points.length;
  const f = (((t % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n;
  const fr = f - Math.floor(f);
  const a = points[i];
  const b = points[(i + 1) % n];
  out.set(a.x + (b.x - a.x) * fr, 0, a.y + (b.y - a.y) * fr);
}

/** Ribbon pair (asphalt + gold underglow), the lapping pulse, and the
 * start-line gantry at index 0 - the outlines' loop origin is the lap
 * line, so the gantry lands where the race actually starts. */
function Circuit({
  data,
  teamColor,
  reduced,
}: {
  data: CircuitData;
  teamColor: string;
  reduced: boolean;
}) {
  const baseGeo = useMemo(() => {
    const g = ribbonGeometry(data.points, RIBBON_WIDTH);
    g.setDrawRange(0, 0);
    return g;
  }, [data]);
  const glowGeo = useMemo(() => {
    const g = ribbonGeometry(data.points, RIBBON_WIDTH * 2.1);
    g.setDrawRange(0, 0);
    return g;
  }, [data]);
  useEffect(
    () => () => {
      baseGeo.dispose();
      glowGeo.dispose();
    },
    [baseGeo, glowGeo]
  );

  const progress = useRef(reduced ? 1 : 0);
  const lap = useRef(0);
  const pulse = useRef<THREE.Group>(null);
  const head = useRef<THREE.Mesh>(null);
  const trailA = useRef<THREE.Mesh>(null);
  const trailB = useRef<THREE.Mesh>(null);
  const light = useRef<THREE.PointLight>(null);
  const tmp = useMemo(
    () => [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
    []
  );

  useEffect(() => {
    progress.current = reduced ? 1 : 0;
    lap.current = 0;
  }, [data, reduced]);

  useFrame((_, dt) => {
    if (!reduced) {
      progress.current = Math.min(1, progress.current + Math.min(dt, 0.05) / DRAW_SECONDS);
    }
    const eased = 1 - Math.pow(1 - progress.current, 3);
    const baseCount = baseGeo.getIndex()?.count ?? 0;
    const glowCount = glowGeo.getIndex()?.count ?? 0;
    baseGeo.setDrawRange(0, Math.floor(baseCount * eased));
    glowGeo.setDrawRange(0, Math.floor(glowCount * eased));

    const live = eased >= 0.999 && !reduced;
    if (pulse.current) pulse.current.visible = live;
    if (!live) return;
    lap.current = (lap.current + Math.min(dt, 0.05) / LAP_SECONDS) % 1;
    const t = lap.current;
    sampleAt(data.points, t, tmp[0]);
    sampleAt(data.points, t - 0.014, tmp[1]);
    sampleAt(data.points, t - 0.028, tmp[2]);
    head.current?.position.copy(tmp[0]);
    trailA.current?.position.copy(tmp[1]);
    trailB.current?.position.copy(tmp[2]);
    light.current?.position.copy(tmp[0].setY(0.9));
  });

  return (
    <group>
      <mesh geometry={glowGeo} position={[0, -0.04, 0]}>
        <meshBasicMaterial
          color="#d3ab63"
          transparent
          opacity={0.13}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
      <mesh geometry={baseGeo}>
        <meshStandardMaterial
          color="#171a21"
          roughness={0.5}
          metalness={0.4}
          side={THREE.DoubleSide}
        />
      </mesh>
      <StartMark data={data} />
      <group ref={pulse} visible={false}>
        <mesh ref={head}>
          <sphereGeometry args={[0.26, 16, 12]} />
          <meshBasicMaterial color={teamColor} />
        </mesh>
        <mesh ref={trailA}>
          <sphereGeometry args={[0.17, 12, 10]} />
          <meshBasicMaterial
            color={teamColor}
            transparent
            opacity={0.5}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <mesh ref={trailB}>
          <sphereGeometry args={[0.12, 12, 10]} />
          <meshBasicMaterial
            color={teamColor}
            transparent
            opacity={0.25}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <pointLight ref={light} color={teamColor} intensity={55} distance={10} decay={1.8} />
      </group>
    </group>
  );
}

/** Start/finish furniture at the loop origin: white start line across the
 * ribbon, twin gold beams and a red light crossbar overhead. */
function StartMark({ data }: { data: CircuitData }) {
  const { pos, rotY } = useMemo(() => {
    const pts = data.points;
    const p0 = pts[0];
    const prev = pts[data.n - 1];
    const next = pts[1];
    const tx = next.x - prev.x;
    const tz = next.y - prev.y;
    const len = Math.hypot(tx, tz) || 1;
    const nx = -tz / len;
    const nz = tx / len;
    // rotation.y that maps the group's local +X onto the track perpendicular
    return { pos: new THREE.Vector3(p0.x, 0, p0.y), rotY: Math.atan2(-nz, nx) };
  }, [data]);
  return (
    <group position={pos} rotation={[0, rotY, 0]}>
      <mesh position={[0, 0.012, 0]}>
        <boxGeometry args={[RIBBON_WIDTH * 1.55, 0.024, 0.4]} />
        <meshBasicMaterial color="#f4f1e8" />
      </mesh>
      <mesh position={[-RIBBON_WIDTH * 0.9, 1.2, 0]}>
        <boxGeometry args={[0.1, 2.4, 0.1]} />
        <meshBasicMaterial color="#d3ab63" />
      </mesh>
      <mesh position={[RIBBON_WIDTH * 0.9, 1.2, 0]}>
        <boxGeometry args={[0.1, 2.4, 0.1]} />
        <meshBasicMaterial color="#d3ab63" />
      </mesh>
      <mesh position={[0, 2.46, 0]}>
        <boxGeometry args={[RIBBON_WIDTH * 1.8 + 0.5, 0.08, 0.12]} />
        <meshBasicMaterial color="#e10600" />
      </mesh>
      <pointLight position={[0, 2.2, 0]} color="#e10600" intensity={10} distance={4.5} decay={1.8} />
    </group>
  );
}

/** Drag/inertia/idle-spin wrapper. Owns the spin state and attaches the
 * drag listeners itself to the wrapper element handed over via `attach`
 * (read-only) - the ribbon is far too thin to raycast reliably under a
 * full hero of text, so dragging is DOM-level, like the race orbit camera. */
function Spin({
  attach,
  reduced,
  children,
}: {
  attach: RefObject<HTMLDivElement | null>;
  reduced: boolean;
  children: ReactNode;
}) {
  const group = useRef<THREE.Group>(null);
  const spin = useRef<SpinState>({ rot: -0.55, vel: 0, lx: 0, dragging: false });

  useEffect(() => {
    const el = attach.current;
    if (!el) return;
    const down = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      spin.current.dragging = true;
      spin.current.lx = e.clientX;
      spin.current.vel = 0;
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      if (!spin.current.dragging) return;
      const dx = e.clientX - spin.current.lx;
      spin.current.lx = e.clientX;
      spin.current.rot += dx * DRAG_GAIN;
      spin.current.vel = dx * DRAG_GAIN;
    };
    const up = () => {
      spin.current.dragging = false;
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [attach]);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    const s = spin.current;
    if (!s.dragging) {
      if (Math.abs(s.vel) > 0.00008) {
        s.rot += s.vel;
        s.vel *= INERTIA_DAMPING;
      } else if (!reduced) {
        s.rot += AUTO_SPEED * Math.min(dt, 0.05);
      }
    }
    g.rotation.y = s.rot;
  });

  return <group ref={group}>{children}</group>;
}

/** Pointer parallax: the camera eases toward the cursor so the circuit
 * reads as a physical object under glass, not a video. */
function CameraRig() {
  const { camera, pointer } = useThree();
  const target = useRef(new THREE.Vector3());
  useFrame(() => {
    target.current.set(pointer.x * 1.7, 17 + pointer.y * 0.9, 21);
    camera.position.lerp(target.current, 0.04);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

export function HeroCircuit() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [reduced, setReduced] = useState(false);
  const trackId = useSessionTrackId();
  const { teamId, driverCode } = useRosterSelection();
  const team = useMemo(
    () => resolveRosterSelection(teamId, driverCode).team,
    [teamId, driverCode]
  );
  const data = useMemo(() => normalizedCircuit(trackId), [trackId]);

  // Pause the loop entirely when the hero scrolls away; honor reduced
  // motion (no idle spin, no pulse - the circuit still renders once).
  useEffect(() => {
    const el = wrapRef.current;
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
    <div
      ref={wrapRef}
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, touchAction: "pan-y", cursor: "grab" }}
    >
      <Canvas
        frameloop={visible ? "always" : "never"}
        dpr={[1, 1.75]}
        camera={{ position: [0, 17, 21], fov: 38 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        onCreated={({ camera }) => camera.lookAt(0, 0, 0)}
      >
        <ambientLight intensity={0.4} />
        <directionalLight position={[8, 14, 6]} intensity={1.1} color="#eef1ff" />
        <directionalLight position={[-10, 6, -8]} intensity={0.4} color="#7aa2ff" />
        <Sparkles
          count={80}
          scale={[46, 20, 46]}
          position={[0, 6, 0]}
          size={1.8}
          speed={0.16}
          opacity={0.5}
          color="#aab2c5"
        />
        <Spin attach={wrapRef} reduced={reduced}>
          <Grid
            position={[0, -0.05, 0]}
            args={[80, 80]}
            infiniteGrid
            cellSize={2.2}
            cellThickness={0.5}
            cellColor="#161a23"
            sectionSize={11}
            sectionThickness={0.9}
            sectionColor="#232a3a"
            fadeDistance={95}
            fadeStrength={1.5}
          />
          <Circuit data={data} teamColor={team.primaryColor} reduced={reduced} />
        </Spin>
        <CameraRig />
      </Canvas>
    </div>
  );
}



