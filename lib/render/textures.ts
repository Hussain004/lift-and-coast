// Tiny generated surface textures (no downloads): greyscale multipliers
// that ride on top of the existing vertex colours, so they add texture
// without changing any palette. Mapped in world space (see Scene/Track),
// mipmapped, a few KB of GPU memory each.
import * as THREE from "three";

let grass: THREE.Texture | null = null;
let asphalt: THREE.Texture | null = null;

/** Seeded so every visit (and every player in a net room) sees the same field. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function greyTexture(size: number, shade: (x: number, y: number, random: () => number) => number): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const image = ctx.createImageData(size, size);
  const random = rng(size * 7919);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.round(255 * Math.min(1, Math.max(0, shade(x, y, random))));
      const o = (y * size + x) * 4;
      image.data[o] = v;
      image.data[o + 1] = v;
      image.data[o + 2] = v;
      image.data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // A multiplier, not a colour: sample the stored values as-is.
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Mowing stripes (8 per tile) with a little blade-level noise and clumps. */
export function grassTexture(): THREE.Texture {
  return (grass ??= greyTexture(256, (x, y, random) => {
    const stripe = Math.floor(x / 32) % 2 === 0 ? 1 : 0.88;
    const clump = 0.04 * Math.sin(x * 0.11 + Math.sin(y * 0.07) * 2) * Math.sin(y * 0.13);
    return stripe + clump + (random() - 0.5) * 0.1;
  }));
}

/** Asphalt grain: fine noise with sparse darker aggregate. */
export function asphaltTexture(): THREE.Texture {
  return (asphalt ??= greyTexture(128, (_x, _y, random) => {
    const speck = random() < 0.06 ? -0.12 : 0;
    return 0.95 + (random() - 0.5) * 0.12 + speck;
  }));
}

/** World-space planar UVs (x/z divided by the tile size in meters). */
export function planarUvs(positions: ArrayLike<number>, tileMeters: number): Float32Array {
  const count = positions.length / 3;
  const uv = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    uv[i * 2] = positions[i * 3] / tileMeters;
    uv[i * 2 + 1] = positions[i * 3 + 2] / tileMeters;
  }
  return uv;
}
