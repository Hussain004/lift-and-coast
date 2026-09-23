"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import {
  QUALITY_SETTINGS,
  stepDownQuality,
  type GraphicsPref,
  type GraphicsQuality,
  type QualitySettings,
} from "@/lib/render/quality";

// Runtime side of lib/render/quality.ts: the active tier as React context,
// the material that honours it, the shadow-casting sun, and the live
// frame-rate adapter behind "auto".

export const QualityContext = createContext<QualitySettings>(QUALITY_SETTINGS.medium);

export function useQuality(): QualitySettings {
  return useContext(QualityContext);
}

/** Lit surface material: PBR standard normally, Lambert on the cheap tier
 * (a fraction of the per-pixel cost - what matters when the GPU is a CPU). */
export function SurfaceMaterial({
  color,
  vertexColors,
  map,
}: {
  color?: string;
  vertexColors?: boolean;
  map?: THREE.Texture;
}) {
  const { cheapMaterials } = useQuality();
  return cheapMaterials ? (
    <meshLambertMaterial color={color} vertexColors={vertexColors} map={map} />
  ) : (
    <meshStandardMaterial color={color} vertexColors={vertexColors} map={map} roughness={0.95} />
  );
}

/**
 * The sun. Its shadow map covers a box around the player's car and moves
 * with it: a 5km circuit can't share one map at any useful resolution, and
 * three's default shadow camera (a 10m box at the world origin) was
 * rendering every caster on the circuit for shadows nobody could see.
 */
export function Sun({
  direction,
  color,
  intensity,
  target,
}: {
  direction: [number, number, number];
  color: string;
  intensity: number;
  target: React.RefObject<THREE.Object3D | null>;
}) {
  const { shadows, shadowMapSize } = useQuality();
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const dir = useRef(new THREE.Vector3(...direction).normalize());
  const at = useRef(new THREE.Vector3());
  const { scene } = useThree();

  useEffect(() => {
    dir.current.set(...direction).normalize();
  }, [direction]);

  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    scene.add(light.target);
    return () => {
      scene.remove(light.target);
    };
  }, [scene]);

  useEffect(() => {
    const light = lightRef.current;
    if (!light || !shadows) return;
    const half = shadowMapSize >= 2048 ? 60 : 42;
    const cam = light.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    light.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    light.shadow.bias = -0.0004;
    light.shadow.normalBias = 0.03;
    light.shadow.map?.dispose();
    light.shadow.map = null;
  }, [shadows, shadowMapSize]);

  useFrame(() => {
    const light = lightRef.current;
    const car = target.current;
    if (!light || !car) return;
    car.getWorldPosition(at.current);
    // Snap to whole texels' worth of world so the shadow edges don't
    // shimmer as the box slides along with the car.
    at.current.x = Math.round(at.current.x);
    at.current.z = Math.round(at.current.z);
    light.target.position.copy(at.current);
    light.position.copy(at.current).addScaledVector(dir.current, 150);
    light.target.updateMatrixWorld();
  });

  return <directionalLight ref={lightRef} color={color} intensity={intensity} castShadow={shadows} />;
}

const SAMPLE_SECONDS = 2;
const LOW_FPS = 40;
const HIGH_FPS = 57;

/**
 * Live adapter behind "auto": every two seconds, a frame rate under 40
 * lowers the render resolution a notch (down to the tier's floor), then
 * drops a whole tier; sustained 57+ wins resolution back up to the tier's
 * ceiling. Explicit tiers keep their resolution fixed. Also feeds the
 * optional F-key performance readout.
 */
export function FrameRateGovernor({
  pref,
  quality,
  onQuality,
  perfRef,
}: {
  pref: GraphicsPref;
  quality: GraphicsQuality;
  onQuality: (quality: GraphicsQuality) => void;
  perfRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const { gl, setDpr } = useThree();
  const settings = QUALITY_SETTINGS[quality];
  const dprRef = useRef(Math.min(settings.maxDpr, typeof window === "undefined" ? 1 : window.devicePixelRatio));
  const frames = useRef(0);
  const elapsed = useRef(0);
  const goodSamples = useRef(0);

  useEffect(() => {
    dprRef.current = Math.min(settings.maxDpr, window.devicePixelRatio);
    setDpr(dprRef.current);
  }, [settings.maxDpr, setDpr]);

  useFrame((_, delta) => {
    frames.current++;
    elapsed.current += Math.min(delta, 0.5);
    if (elapsed.current < SAMPLE_SECONDS) return;
    const fps = frames.current / elapsed.current;
    frames.current = 0;
    elapsed.current = 0;
    const info = gl.info.render;
    writePerfReadout(
      perfRef?.current ?? null,
      `${fps.toFixed(0)} FPS · ${quality.toUpperCase()}${pref === "auto" ? " (AUTO)" : ""} · ${dprRef.current.toFixed(2)}x · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris`
    );
    if (pref !== "auto") return;
    if (fps < LOW_FPS) {
      goodSamples.current = 0;
      if (dprRef.current > settings.minDpr + 0.01) {
        dprRef.current = Math.max(settings.minDpr, dprRef.current - 0.1);
        setDpr(dprRef.current);
      } else if (quality !== "low") {
        onQuality(stepDownQuality(quality));
      }
    } else if (fps >= HIGH_FPS) {
      goodSamples.current++;
      if (goodSamples.current >= 3 && dprRef.current < Math.min(settings.maxDpr, window.devicePixelRatio) - 0.01) {
        goodSamples.current = 0;
        dprRef.current = Math.min(settings.maxDpr, dprRef.current + 0.1);
        setDpr(dprRef.current);
      }
    } else {
      goodSamples.current = 0;
    }
  });

  return null;
}

/** Writes the readout only while it's toggled on (see Scene's F key). */
function writePerfReadout(el: HTMLDivElement | null, text: string): void {
  if (el && el.dataset.visible === "1") el.textContent = text;
}
