"use client";

import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";

// Bloom for the High graphics tier: the scene renders to a half-float
// target (so the sun-lit kerbs, floodlight heads and rear lights keep
// their over-bright values), the bloom pass blurs what is brighter than the
// threshold back over the frame, and OutputPass applies the renderer's own
// tone mapping and colour space - so the image matches the plain path,
// only with glow. Drawing here at a positive useFrame priority takes over
// R3F's own render call.

interface BloomRig {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
}

function createRig(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): BloomRig {
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(gl, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.3, 0.6, 1.6);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return { composer, bloom };
}

function resizeRig(rig: BloomRig, width: number, height: number, dpr: number): void {
  rig.composer.setPixelRatio(dpr);
  rig.composer.setSize(width, height);
}

function tuneRig(rig: BloomRig, strength: number, threshold: number): void {
  rig.bloom.strength = strength;
  rig.bloom.threshold = threshold;
}

function disposeRig(rig: BloomRig): void {
  rig.composer.dispose();
  rig.bloom.dispose();
}

export function Bloom({ night }: { night: boolean }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const dpr = useThree((s) => s.viewport.dpr);
  const rig = useMemo(() => createRig(gl, scene, camera), [gl, scene, camera]);
  useEffect(() => {
    resizeRig(rig, size.width, size.height, dpr);
  }, [rig, size.width, size.height, dpr]);
  useEffect(() => {
    // By day only the hottest highlights glow; at night the lamps and rear
    // lights are most of what there is to see.
    tuneRig(rig, night ? 0.85 : 0.3, night ? 1.0 : 1.6);
  }, [rig, night]);
  useEffect(() => () => disposeRig(rig), [rig]);
  useFrame((_, delta) => {
    rig.composer.render(delta);
  }, 1);
  return null;
}
