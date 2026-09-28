import type { RewindSample } from "./rewindBuffer";

/** Floats per pose: position 3, rotation 4, linvel 3, angvel 3. */
const STRIDE = 13;

/**
 * Fixed-capacity, step-indexed ring of full physics poses in one
 * Float32Array - the AI cars' instant-replay recording. A 20-car field at
 * 60Hz for 45s is ~54k poses; as objects (the rewind buffer's format) that
 * is ~16MB of small allocations, as packed floats ~2.8MB and no GC churn.
 *
 * Indexed by steps back from the newest pose, so it lines up with the
 * player's replay (see secondsBehindLive in replay.ts), which is also one
 * frame per physics step.
 */
export function createPoseRing(capacitySeconds: number, timestep: number) {
  const capacity = Math.max(2, Math.round(capacitySeconds / timestep));
  const data = new Float32Array(capacity * STRIDE);
  let head = 0; // next write slot
  let count = 0;

  function push(p: RewindSample) {
    const o = head * STRIDE;
    data[o] = p.position.x;
    data[o + 1] = p.position.y;
    data[o + 2] = p.position.z;
    data[o + 3] = p.rotation.x;
    data[o + 4] = p.rotation.y;
    data[o + 5] = p.rotation.z;
    data[o + 6] = p.rotation.w;
    data[o + 7] = p.linvel.x;
    data[o + 8] = p.linvel.y;
    data[o + 9] = p.linvel.z;
    data[o + 10] = p.angvel.x;
    data[o + 11] = p.angvel.y;
    data[o + 12] = p.angvel.z;
    head = (head + 1) % capacity;
    count = Math.min(capacity, count + 1);
  }

  /** The pose `secondsAgo` behind the newest one, clamped to what is held. */
  function sampleAt(secondsAgo: number): RewindSample | null {
    if (count === 0) return null;
    const back = Math.min(count - 1, Math.max(0, Math.round(secondsAgo / timestep)));
    const o = ((head - 1 - back + capacity * 2) % capacity) * STRIDE;
    return {
      position: { x: data[o], y: data[o + 1], z: data[o + 2] },
      rotation: { x: data[o + 3], y: data[o + 4], z: data[o + 5], w: data[o + 6] },
      linvel: { x: data[o + 7], y: data[o + 8], z: data[o + 9] },
      angvel: { x: data[o + 10], y: data[o + 11], z: data[o + 12] },
    };
  }

  function clear() {
    head = 0;
    count = 0;
  }

  return { push, sampleAt, clear };
}
