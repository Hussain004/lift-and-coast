"use client";

import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import type { AudioCarSnapshot, AudioSnapshot } from "@/lib/audio/raceAudio";
import type { WeatherHandle } from "@/lib/race/raceOps";

/**
 * Per-frame effects that make the circuit feel alive, all bounded, all one
 * draw call each, all off on the Low graphics tier (see quality.ts):
 *
 * - Sparks: the titanium skid-block shower at high speed and over kerbs,
 *   for every car on the grid.
 * - Spray: the rooster tail behind each car on a wet track.
 * - Skid marks: rubber laid where the player's rear tyres slide.
 *
 * Sparks and spray read the per-car snapshot the audio rig already gets
 * (position, velocity, kerb contact), so no car logic changed for them.
 */

/** Car.tsx pushes skid stamps here; SkidMarks drains it each frame. */
export interface FxBus {
  /** Flat [x, y, z, heading, length, ...] strips to lay: centre, direction of travel, metres. */
  skids: number[];
}

export function createFxBus(): FxBus {
  return { skids: [] };
}

// ---------- particles ----------

interface ParticleSpec {
  capacity: number;
  size: number;
  /** Base colour at birth; fades to black (additive, so black is invisible). */
  color: [number, number, number];
  gravity: number;
  drag: number;
  texture: THREE.Texture | null;
}

/** A round sprite: `sharp` keeps a bright core (sparks), otherwise a soft puff (spray). */
function dotTexture(sharp: boolean): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 32;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(sharp ? 0.2 : 0.4, sharp ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.55)");
  grad.addColorStop(sharp ? 0.55 : 1, sharp ? "rgba(255,255,255,0.25)" : "rgba(255,255,255,0)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

interface ParticlePool {
  spec: ParticleSpec;
  positions: Float32Array;
  colors: Float32Array;
  velocity: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  geometry: THREE.BufferGeometry;
  material: THREE.PointsMaterial;
  next: number;
}

/** A fixed pool of additive points; spawnParticle recycles the oldest. */
function createParticlePool(spec: ParticleSpec): ParticlePool {
  const positions = new Float32Array(spec.capacity * 3).fill(0);
  const colors = new Float32Array(spec.capacity * 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  // Culling a pool that moves with the cars would need a per-frame bounds
  // update; it is a few hundred points, so it is drawn unculled.
  const material = new THREE.PointsMaterial({
    size: spec.size,
    vertexColors: true,
    map: spec.texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  return {
    spec,
    positions,
    colors,
    velocity: new Float32Array(spec.capacity * 3),
    life: new Float32Array(spec.capacity),
    maxLife: new Float32Array(spec.capacity).fill(1),
    geometry,
    material,
    next: 0,
  };
}

function spawnParticle(
  pool: ParticlePool,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
  lifeSeconds: number
): void {
  const i = pool.next;
  pool.next = (pool.next + 1) % pool.spec.capacity;
  pool.positions.set([x, y, z], i * 3);
  pool.velocity.set([vx, vy, vz], i * 3);
  pool.life[i] = lifeSeconds;
  pool.maxLife[i] = lifeSeconds;
}

function stepParticles(pool: ParticlePool, dt: number): void {
  const { positions, colors, velocity, life, maxLife, spec } = pool;
  const drag = Math.exp(-spec.drag * dt);
  for (let i = 0; i < spec.capacity; i++) {
    if (life[i] <= 0) {
      colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = 0;
      continue;
    }
    life[i] -= dt;
    velocity[i * 3] *= drag;
    velocity[i * 3 + 2] *= drag;
    velocity[i * 3 + 1] = velocity[i * 3 + 1] * drag - spec.gravity * dt;
    positions[i * 3] += velocity[i * 3] * dt;
    positions[i * 3 + 1] += velocity[i * 3 + 1] * dt;
    positions[i * 3 + 2] += velocity[i * 3 + 2] * dt;
    const k = Math.max(0, life[i] / maxLife[i]);
    colors[i * 3] = spec.color[0] * k;
    colors[i * 3 + 1] = spec.color[1] * k * k;
    colors[i * 3 + 2] = spec.color[2] * k * k;
  }
  pool.geometry.attributes.position.needsUpdate = true;
  pool.geometry.attributes.color.needsUpdate = true;
}

function forEachCar(audio: AudioSnapshot, fn: (car: AudioCarSnapshot) => void) {
  fn(audio.player);
  for (const car of audio.opponents) if (car) fn(car);
}

/** 200 km/h: below this the floor is not pressed close enough to the road to spark. */
const SPARK_SPEED_MS = 55;
const MAX_SPARKS_PER_FRAME = 48;

export function Sparks({ audioRef }: { audioRef: React.RefObject<AudioSnapshot> }) {
  const pool = useMemo(
    () => createParticlePool({ capacity: 400, size: 0.15, color: [0.75, 0.5, 0.22], gravity: 9, drag: 1.5, texture: dotTexture(true) }),
    []
  );
  useFrame((_, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    let budget = MAX_SPARKS_PER_FRAME;
    forEachCar(audioRef.current, (car) => {
      if (budget <= 0 || car.y === undefined) return;
      const speed = Math.hypot(car.vx, car.vz);
      if (speed < SPARK_SPEED_MS && car.kerb01 < 0.3) return;
      // Bursts, not a stream: showers per second rise with speed and with
      // kerb contact (the floor bottoming out). A rate, not a per-frame
      // chance, so a 144Hz screen does not throw more sparks than a 60Hz one.
      const perSecond = (speed >= SPARK_SPEED_MS ? 3 + ((speed - SPARK_SPEED_MS) / 40) * 12 : 0) + car.kerb01 * 18;
      if (Math.random() > 1 - Math.exp(-perSecond * dt)) return;
      const fx = -Math.sin(car.yawRad);
      const fz = -Math.cos(car.yawRad);
      const n = 3 + Math.floor(Math.random() * 4);
      for (let k = 0; k < n && budget > 0; k++, budget--) {
        const lateral = (Math.random() - 0.5) * 0.9;
        spawnParticle(
          pool,
          car.x - fx * 2.8 + fz * lateral,
          car.y - 0.3,
          car.z - fz * 2.8 - fx * lateral,
          car.vx * 0.82 + (Math.random() - 0.5) * 4,
          1.2 + Math.random() * 2.6,
          car.vz * 0.82 + (Math.random() - 0.5) * 4,
          0.2 + Math.random() * 0.3
        );
      }
    });
    stepParticles(pool, dt);
  });
  return <points geometry={pool.geometry} material={pool.material} frustumCulled={false} renderOrder={5} />;
}

export function Spray({
  audioRef,
  weatherRef,
}: {
  audioRef: React.RefObject<AudioSnapshot>;
  weatherRef: React.RefObject<WeatherHandle>;
}) {
  const pool = useMemo(
    () => createParticlePool({ capacity: 900, size: 2.0, color: [0.2, 0.21, 0.22], gravity: 1.0, drag: 2.4, texture: dotTexture(false) }),
    []
  );
  useFrame((_, rawDt) => {
    const dt = Math.min(0.05, rawDt);
    const wet = weatherRef.current?.snapshot().wetness ?? 0;
    if (wet > 0.2) {
      forEachCar(audioRef.current, (car) => {
        if (car.y === undefined) return;
        const speed = Math.hypot(car.vx, car.vz);
        if (speed < 18) return;
        const fx = -Math.sin(car.yawRad);
        const fz = -Math.cos(car.yawRad);
        // Puffs per second from speed and wetness, turned into a whole count
        // for this frame (fraction by chance) so the density is frame-rate
        // independent.
        const expected = Math.min(8, (speed / 25) * wet * 28 * dt);
        const n = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const side = Math.random() < 0.5 ? -0.75 : 0.75;
          spawnParticle(
          pool,
            car.x - fx * 1.7 + fz * side,
            car.y - 0.1,
            car.z - fz * 1.7 - fx * side,
            car.vx * 0.55 + (Math.random() - 0.5) * 3,
            0.8 + Math.random() * 1.6,
            car.vz * 0.55 + (Math.random() - 0.5) * 3,
            0.5 + Math.random() * 0.5
          );
        }
      });
    }
    stepParticles(pool, dt);
  });
  return <points geometry={pool.geometry} material={pool.material} frustumCulled={false} renderOrder={4} />;
}

// ---------- skid marks ----------

const SKID_CAPACITY = 700;
/** The unit strip's length in metres; each stamp scales it to the distance travelled. */
const SKID_LENGTH = 1;

export function SkidMarks({ fxRef }: { fxRef: React.RefObject<FxBus> }) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const nextRef = useRef(0);
  const { geometry, material, dummy } = useMemo(() => {
    const g = new THREE.PlaneGeometry(0.28, SKID_LENGTH);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({
      color: "#0b0b0c",
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    return { geometry: g, material: m, dummy: new THREE.Object3D() };
  }, []);
  useFrame(() => {
    const mesh = meshRef.current;
    const skids = fxRef.current.skids;
    if (!mesh || skids.length === 0) return;
    for (let i = 0; i + 4 < skids.length; i += 5) {
      dummy.position.set(skids[i], skids[i + 1] + 0.02, skids[i + 2]);
      dummy.rotation.set(0, skids[i + 3], 0);
      dummy.scale.set(1, 1, (skids[i + 4] * 1.1) / SKID_LENGTH);
      dummy.updateMatrix();
      mesh.setMatrixAt(nextRef.current, dummy.matrix);
      nextRef.current = (nextRef.current + 1) % SKID_CAPACITY;
    }
    skids.length = 0;
    mesh.count = SKID_CAPACITY;
    mesh.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh
      ref={meshRef}
      args={[geometry, material, SKID_CAPACITY]}
      frustumCulled={false}
      renderOrder={1}
      // Unused slots start as zero-scale matrices (invisible) - see onUpdate.
      onUpdate={(mesh) => {
        if (mesh.userData.initialised) return;
        mesh.userData.initialised = true;
        const zero = new THREE.Matrix4().makeScale(0, 0, 0);
        for (let i = 0; i < SKID_CAPACITY; i++) mesh.setMatrixAt(i, zero);
        mesh.instanceMatrix.needsUpdate = true;
      }}
    />
  );
}
