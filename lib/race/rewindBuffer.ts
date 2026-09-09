export interface RewindSample {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
  linvel: { x: number; y: number; z: number };
  angvel: { x: number; y: number; z: number };
}

/**
 * Fixed-timestep ring buffer of recent physics states, for a "hold to
 * rewind" flashback after spinning off. Backed by a plain array - at 60Hz
 * for a few seconds of history that's a few hundred elements, and shift()
 * on that is trivial, so a true circular buffer would be premature.
 */
export function createRewindBuffer(capacitySeconds: number, timestep: number) {
  const capacity = Math.max(1, Math.round(capacitySeconds / timestep));
  const samples: RewindSample[] = [];

  function push(sample: RewindSample) {
    samples.push(sample);
    if (samples.length > capacity) samples.shift();
  }

  function indexFor(secondsAgo: number): number | null {
    if (samples.length === 0) return null;
    const stepsBack = Math.round(secondsAgo / timestep);
    return Math.min(samples.length - 1, Math.max(0, samples.length - 1 - stepsBack));
  }

  /** Read-only peek at the state `secondsAgo` back, clamped to what's available. */
  function sampleAt(secondsAgo: number): RewindSample | null {
    const idx = indexFor(secondsAgo);
    return idx === null ? null : samples[idx];
  }

  /**
   * Resumes the timeline from `secondsAgo` back, discarding every sample
   * newer than that point - the scrubbed-past "future" is genuinely gone,
   * so a later rewind can't jump into stale data left over from this one.
   *
   * ponytail: this means history is consumed by rewinding - if you rewind
   * 3s back then immediately rewind again, there's only ~2s of buffer left
   * (from the resume point backward), not another full 5s. Deliberate
   * simplification over tracking a separate write cursor to let pushes
   * overwrite the discarded future; revisit if repeated back-to-back
   * rewinds turn out to matter for feel.
   */
  function resumeFrom(secondsAgo: number): RewindSample | null {
    const idx = indexFor(secondsAgo);
    if (idx === null) return null;
    const sample = samples[idx];
    samples.length = idx + 1;
    return sample;
  }

  function oldestAvailableSeconds(): number {
    return Math.max(0, samples.length - 1) * timestep;
  }

  function clear() {
    samples.length = 0;
  }

  return { push, sampleAt, resumeFrom, oldestAvailableSeconds, clear };
}
