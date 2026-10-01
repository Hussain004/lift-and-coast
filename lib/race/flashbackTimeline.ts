/**
 * The flashback timeline: press R, the race pauses, and you scrub back through
 * the last REWIND_CAPACITY_SECONDS before confirming to resume from there.
 *
 * This replaces "hold R to rewind" as the primary interaction, which is what
 * roadmap 11.6 asks for. Hold-to-rewind is a single blind gesture: you cannot
 * see how far back you are going or what happened, so you either rewind too
 * little and drive straight back into the thing that spun you, or too far and
 * lose the corner you had already committed to. A scrub bar makes the same
 * gesture precise, and the strip below makes it informed.
 *
 * WHY THERE ARE NO THUMBNAILS. The F1 game's timeline shows film frames. We
 * cannot: this project's frame budget is about 300 draw calls on hardware
 * with no discrete GPU, and rendering even a handful of live thumbnails during
 * a pause would mean reading and re-uploading several render targets per
 * scrub step. Instead the strip is drawn from a small ring of NUMERIC samples
 * (speed, throttle, brake, contact) that costs one typed-array write per
 * physics step and no draw calls at all. See FlashbackTrace.
 *
 * SCOPE, same as every other player-only rule here: this is a pure state
 * machine over numbers. It moves no car, applies no force, and knows nothing
 * about the AI beyond the fact that the underlying rewind buffer is shared.
 * Resuming still goes through the existing rewindBuffer.resumeFrom path, so
 * the physics behaviour of a flashback is unchanged by this UI existing.
 */

import { REWIND_CAPACITY_SECONDS } from "./rewindBuffer";

/** How the timeline is currently being used. */
export type FlashbackTimelineMode = "closed" | "scrubbing";

/** What a confirm or cancel did, for the caller to act on. */
export type FlashbackTimelineExit =
  | { kind: "still-open"; secondsAgo: number }
  | { kind: "confirmed"; secondsAgo: number }
  | { kind: "cancelled" };

export interface FlashbackTimelineState {
  mode: FlashbackTimelineMode;
  /** Scrub head, seconds back from now. Always 0 while closed. */
  secondsAgo: number;
  /** How far back the buffer can actually go right now, seconds. */
  capacity: number;
  /**
   * Bumped on every change so a UI can redraw. The strip is redrawn from the
   * trace at HUD rates rather than per frame, so this exists to say "the
   * numbers moved", not "repaint everything".
   */
  serial: number;
}

export function createFlashbackTimeline(): FlashbackTimelineState {
  return { mode: "closed", secondsAgo: 0, capacity: 0, serial: 0 };
}

/**
 * Opens the timeline, head at the start of the buffer.
 *
 * Starting at the OLDEST sample rather than at zero is deliberate: the gesture
 * is "I want to see what happened", and the first thing to look at is the
 * beginning of the window, not the present moment you are already standing in.
 * The player then scrubs forward to the point they want, which is the opposite
 * of dragging a slider from a fixed end and is why the confirm/cancel keys are
 * documented in the HUD hint rather than assumed.
 */
export function openFlashbackTimeline(
  state: FlashbackTimelineState,
  capacity: number
): FlashbackTimelineState {
  state.mode = "scrubbing";
  state.capacity = Math.max(0, Math.min(REWIND_CAPACITY_SECONDS, capacity));
  state.secondsAgo = state.capacity;
  state.serial += 1;
  return state;
}

/** Closes without resuming from anywhere: the race carries on as it was. */
export function cancelFlashbackTimeline(state: FlashbackTimelineState): FlashbackTimelineExit {
  if (state.mode === "closed") return { kind: "cancelled" };
  state.mode = "closed";
  state.secondsAgo = 0;
  state.capacity = 0;
  state.serial += 1;
  return { kind: "cancelled" };
}

/**
 * Confirms and reports how far back to resume.
 *
 * Refuses to move the head at all when the timeline is closed, and when the
 * scrub is at zero: confirming "no rewind" is how a player dismisses the
 * timeline without spending a flashback, so it must NOT be reported as a
 * confirm at a non-zero distance. The caller spends a flashback from
 * lib/race/flashbacks.ts on the secondsAgo value, and a zero there is a
 * no-op in that module too - but the distinction is kept explicit here so
 * "confirmed" always means "the player asked to go back".
 */
export function confirmFlashbackTimeline(state: FlashbackTimelineState): FlashbackTimelineExit {
  if (state.mode === "closed") return { kind: "cancelled" };
  const secondsAgo = clampScrub(state.secondsAgo, state.capacity);
  state.mode = "closed";
  state.secondsAgo = 0;
  state.capacity = 0;
  state.serial += 1;
  return { kind: "confirmed", secondsAgo };
}

/** Moves the scrub head, clamped to what the buffer holds. */
export function scrubFlashbackTimeline(state: FlashbackTimelineState, secondsAgo: number): number {
  if (state.mode === "closed") return 0;
  state.secondsAgo = clampScrub(secondsAgo, state.capacity);
  state.serial += 1;
  return state.secondsAgo;
}

/** Nudges the head by a signed amount, for the arrow keys. */
export function nudgeFlashbackTimeline(
  state: FlashbackTimelineState,
  deltaSeconds: number
): number {
  if (state.mode === "closed") return 0;
  return scrubFlashbackTimeline(state, state.secondsAgo + deltaSeconds);
}

/** Whole-second steps for the keyboard, so the strip and the readout agree. */
export const SCRUB_STEP_SECONDS = 0.5;

function clampScrub(secondsAgo: number, capacity: number): number {
  if (!Number.isFinite(secondsAgo)) return 0;
  return Math.max(0, Math.min(capacity, secondsAgo));
}

export function isFlashbackTimelineOpen(state: FlashbackTimelineState): boolean {
  return state.mode === "scrubbing";
}

/** The HUD hint while the timeline is open. */
export function flashbackTimelineHint(state: FlashbackTimelineState): string {
  if (state.mode === "closed") return "";
  const seconds = state.secondsAgo.toFixed(1);
  return `FLASHBACK  ${seconds}s / ${state.capacity.toFixed(1)}s   ← → SCRUB   ENTER CONFIRM   ESC CANCEL`;
}

/**
 * The trace: a tiny ring of the numbers the strip draws.
 *
 * Deliberately NOT the 60Hz rewind buffer. That one stores full rigid-body
 * poses for the whole field, and the strip needs none of it - a speed trace
 * and two bars at 10Hz is enough to see what happened, and at that rate a
 * full 15 second window costs about 150 records. Kept as parallel
 * number arrays rather than objects so the scrub reads touch no allocation,
 * which matters because it reads on every HUD frame while open.
 */
export const FLASHBACK_TRACE_HZ = 10;
/**
 * Sized to hold the rewind window and NOT a moment more.
 *
 * The first cut added a few slots of slack, which let the strip offer 15.3s of
 * scrub against a 15s rewind buffer - so a player could drag the head to a
 * point the buffer could not actually resume from, and get a confirm that
 * silently did nothing. The trace must never be able to promise more history
 * than `rewindBuffer` can service, so the capacity is exactly the window and
 * `spanSeconds` lands a tenth under it (an N-sample ring spans N-1 gaps).
 */
const TRACE_CAPACITY = Math.ceil(REWIND_CAPACITY_SECONDS * FLASHBACK_TRACE_HZ);

export function createFlashbackTrace() {
  const speedKmh = new Float32Array(TRACE_CAPACITY);
  const throttle = new Float32Array(TRACE_CAPACITY);
  const brake = new Float32Array(TRACE_CAPACITY);
  const contact = new Uint8Array(TRACE_CAPACITY);
  let length = 0;
  let accumulator = 0;
  // Monotonic clock of the newest sample, seconds. Only ever increases, so the
  // strip can label "now" without a second time source.
  let newestSeconds = 0;

  /**
   * Feeds one physics step. Rate-limited internally to FLASHBACK_TRACE_HZ, so
   * the caller can call this every step (60Hz) without thinking about it and
   * without the ring growing to 900 entries.
   *
   * The tolerance below is load-bearing, not fussy. Accumulating 1/10 in binary
   * floating point does not give exactly 0.1, it gives slightly less, so a bare
   * `accumulator < step` test drops every other sample and the trace runs at
   * half rate - which reads as a trace that is subtly time-shifted rather than
   * as an obvious bug. The epsilon makes the comparison inclusive, and the
   * clamp stops a pathological dt from writing a burst of samples in one step.
   */
  function record(dt: number, sample: { speedKmh: number; throttle: number; brake: number; contact: boolean }): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    newestSeconds += dt;
    accumulator += dt;
    const step = 1 / FLASHBACK_TRACE_HZ;
    // At most one sample per call: this is a decimator, not a catch-up loop.
    // A long frame therefore drops its extra time rather than writing a burst
    // of back-dated samples, which keeps the trace monotonic in the physics
    // clock instead of inventing history that never happened.
    if (accumulator < step - 1e-9) return;
    accumulator = Math.min(accumulator - step, step);
    if (length === TRACE_CAPACITY) {
      speedKmh.copyWithin(0, 1);
      throttle.copyWithin(0, 1);
      brake.copyWithin(0, 1);
      contact.copyWithin(0, 1);
      length -= 1;
    }
    speedKmh[length] = sample.speedKmh;
    throttle[length] = sample.throttle;
    brake[length] = sample.brake;
    contact[length] = sample.contact ? 1 : 0;
    length += 1;
  }

  function clear(): void {
    length = 0;
    accumulator = 0;
    newestSeconds = 0;
  }

  /** Seconds of trace currently held, which is what the strip can draw. */
  function spanSeconds(): number {
    return length === 0 ? 0 : (length - 1) / FLASHBACK_TRACE_HZ;
  }

  /**
   * Reads one column of the strip, `secondsAgo` back from the newest sample.
   *
   * Index arithmetic only - no allocation, no filtering, no interpolation. A
   * trace sampled at 10Hz is plenty for a strip the width of a small panel,
   * and nearest-sample is the honest thing to draw: interpolating between two
   * physics steps would show a speed the car was never actually at.
   */
  function readAt(secondsAgo: number): {
    speedKmh: number;
    throttle: number;
    brake: number;
    contact: boolean;
  } | null {
    if (length === 0) return null;
    const stepsBack = Math.round(secondsAgo * FLASHBACK_TRACE_HZ);
    const index = length - 1 - stepsBack;
    if (index < 0) return null;
    return {
      speedKmh: speedKmh[index],
      throttle: throttle[index],
      brake: brake[index],
      contact: contact[index] === 1,
    };
  }

  return { record, clear, spanSeconds, readAt, get newestSeconds() { return newestSeconds; } };
}

/**
 * The strip as a flat list of columns, oldest first, for drawing.
 *
 * Kept separate from the trace itself so the trace stays a storage buffer with
 * no opinions about pixels, and so this - the part that knows about column
 * counts and scaling - is the thing a unit test can check. Bounded to
 * `columns` because that is the width of the element it fills; asking for more
 * than the panel has pixels would just cost time.
 */
export interface StripColumn {
  speed01: number;
  throttle01: number;
  brake01: number;
  contact: boolean;
}

export function buildFlashbackStrip(
  trace: ReturnType<typeof createFlashbackTrace>,
  secondsAgo: number,
  columns: number
): StripColumn[] {
  const width = Math.max(1, Math.min(240, Math.round(columns)));
  const span = trace.spanSeconds();
  if (span <= 0) return [];
  const out: StripColumn[] = [];
  // Newest column on the right, so the scrub head moves left as the player
  // goes back in time - the same direction the timeline reads.
  for (let column = width - 1; column >= 0; column -= 1) {
    const at = (column / (width - 1 || 1)) * span;
    const sample = trace.readAt(at);
    if (!sample) {
      out.push({ speed01: 0, throttle01: 0, brake01: 0, contact: false });
      continue;
    }
    out.push({
      // Normalised against a reference speed rather than the window's own max,
      // so two strips of the same stint are directly comparable and a slow
      // corner does not get scaled up into looking like a fast straight.
      speed01: Math.min(1, Math.max(0, sample.speedKmh / FLASHBACK_STRIP_REFERENCE_KMH)),
      throttle01: Math.min(1, Math.max(0, sample.throttle)),
      brake01: Math.min(1, Math.max(0, sample.brake)),
      contact: sample.contact,
    });
  }
  return out;
}

/** Full-scale speed for the strip's trace, km/h. A shade under top speed. */
export const FLASHBACK_STRIP_REFERENCE_KMH = 320;

/**
 * The same strip, written into a caller-owned array.
 *
 * This is the form the HUD actually uses. `buildFlashbackStrip` allocates a
 * fresh array, which is right for a test and wrong for a 20Hz HUD tick in the
 * middle of a pause - a per-tick allocation is exactly the thing this widget
 * exists to avoid. The widget keeps one array, sized to its column count, and
 * refills it in place; nothing is created and nothing is read from React state.
 */
export function writeFlashbackStrip(
  trace: ReturnType<typeof createFlashbackTrace>,
  secondsAgo: number,
  out: StripColumn[]
): number {
  const width = out.length;
  if (width === 0) return 0;
  const span = trace.spanSeconds();
  if (span <= 0) return 0;
  let written = 0;
  // Newest column on the right, so the scrub head moves left as the player
  // goes back in time - the same direction the timeline reads.
  for (let column = width - 1; column >= 0; column -= 1) {
    const at = (column / (width - 1 || 1)) * span;
    const sample = trace.readAt(at);
    const target = out[width - 1 - column];
    if (!sample) {
      target.speed01 = 0;
      target.throttle01 = 0;
      target.brake01 = 0;
      target.contact = false;
      continue;
    }
    target.speed01 = Math.min(1, Math.max(0, sample.speedKmh / FLASHBACK_STRIP_REFERENCE_KMH));
    target.throttle01 = Math.min(1, Math.max(0, sample.throttle));
    target.brake01 = Math.min(1, Math.max(0, sample.brake));
    target.contact = sample.contact;
    written += 1;
  }
  void secondsAgo;
  return written;
}

/** Where the scrub head sits in a strip of `columns` wide, 0..1 from the left. */
export function flashStripHeadFraction(secondsAgo: number, span: number, columns: number): number {
  if (span <= 0 || columns <= 1) return 1;
  return Math.max(0, Math.min(1, 1 - secondsAgo / span));
}
