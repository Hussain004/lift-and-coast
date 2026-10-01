import { describe, expect, it } from "vitest";
import {
  FLASHBACK_STRIP_REFERENCE_KMH,
  FLASHBACK_TRACE_HZ,
  SCRUB_STEP_SECONDS,
  buildFlashbackStrip,
  cancelFlashbackTimeline,
  confirmFlashbackTimeline,
  createFlashbackTimeline,
  createFlashbackTrace,
  flashStripHeadFraction,
  flashbackTimelineHint,
  isFlashbackTimelineOpen,
  nudgeFlashbackTimeline,
  openFlashbackTimeline,
  scrubFlashbackTimeline,
  writeFlashbackStrip,
} from "../lib/race/flashbackTimeline";
import { REWIND_CAPACITY_SECONDS } from "../lib/race/rewindBuffer";

/**
 * Roadmap 11.6: the flashback timeline. Two separate things are checked here
 * and they are checked separately on purpose:
 *
 *  - the scrub-to-sample mapping and the cancel/confirm contract, which is the
 *    part that can silently send the player to the wrong place in time, and
 *  - the trace, which is the thing standing in for the filmstrip the F1 game
 *    shows. The trace has no draw calls, so its cost is measured in
 *    allocation and index arithmetic instead.
 */

describe("opening and closing the timeline", () => {
  it("starts closed with no capacity", () => {
    const state = createFlashbackTimeline();
    expect(state.mode).toBe("closed");
    expect(state.secondsAgo).toBe(0);
    expect(isFlashbackTimelineOpen(state)).toBe(false);
    expect(flashbackTimelineHint(state)).toBe("");
  });

  it("opens with the head at the oldest sample, not at now", () => {
    // Opening at "now" would show the player the moment they are already
    // standing in, which is useless. The gesture is "show me what happened",
    // so the head starts at the far end of the window.
    const state = openFlashbackTimeline(createFlashbackTimeline(), 12);
    expect(state.mode).toBe("scrubbing");
    expect(state.secondsAgo).toBe(12);
    expect(state.capacity).toBe(12);
    expect(isFlashbackTimelineOpen(state)).toBe(true);
  });

  it("never claims more capacity than the buffer can hold", () => {
    // A caller passing a silly capacity must not produce a timeline that
    // offers a scrub the rewind buffer cannot service.
    expect(openFlashbackTimeline(createFlashbackTimeline(), 999).capacity).toBe(
      REWIND_CAPACITY_SECONDS
    );
    expect(openFlashbackTimeline(createFlashbackTimeline(), -5).capacity).toBe(0);
  });

  it("cancel returns to the race as it was and keeps nothing", () => {
    const state = openFlashbackTimeline(createFlashbackTimeline(), 10);
    scrubFlashbackTimeline(state, 4);
    const exit = cancelFlashbackTimeline(state);
    expect(exit).toEqual({ kind: "cancelled" });
    expect(state.mode).toBe("closed");
    expect(state.secondsAgo).toBe(0);
    expect(state.capacity).toBe(0);
  });

  it("cancel on a closed timeline is a no-op, not an error", () => {
    // The key handler cannot know whether the timeline was open when the key
    // landed, so both keys must be safe to press at any time.
    const state = createFlashbackTimeline();
    expect(cancelFlashbackTimeline(state)).toEqual({ kind: "cancelled" });
    expect(confirmFlashbackTimeline(state)).toEqual({ kind: "cancelled" });
    expect(scrubFlashbackTimeline(state, 5)).toBe(0);
    expect(nudgeFlashbackTimeline(state, 1)).toBe(0);
  });

  it("confirm reports the scrubbed distance and closes", () => {
    const state = openFlashbackTimeline(createFlashbackTimeline(), 15);
    scrubFlashbackTimeline(state, 3.5);
    const exit = confirmFlashbackTimeline(state);
    expect(exit).toEqual({ kind: "confirmed", secondsAgo: 3.5 });
    expect(state.mode).toBe("closed");
    expect(state.secondsAgo).toBe(0);
  });

  it("confirm at zero is still a confirm, so dismissing costs nothing", () => {
    // The player opens the timeline, changes their mind and confirms. That has
    // to read as "confirmed" rather than "cancelled" so the caller can decide,
    // but the distance is zero, and lib/race/flashbacks.ts treats a zero
    // rewind as a no-op so no allowance is spent.
    const state = openFlashbackTimeline(createFlashbackTimeline(), 10);
    scrubFlashbackTimeline(state, 0);
    expect(confirmFlashbackTimeline(state)).toEqual({ kind: "confirmed", secondsAgo: 0 });
  });
});

describe("scrubbing", () => {
  it("clamps to the capacity at both ends", () => {
    const state = openFlashbackTimeline(createFlashbackTimeline(), 10);
    expect(scrubFlashbackTimeline(state, 999)).toBe(10);
    expect(scrubFlashbackTimeline(state, -999)).toBe(0);
    expect(scrubFlashbackTimeline(state, NaN)).toBe(0);
    expect(scrubFlashbackTimeline(state, Infinity)).toBe(0);
  });

  it("nudges by a signed amount and stops at the ends", () => {
    // Positive means FURTHER BACK in time, which is the direction the arrow
    // keys are bound to. Getting this backwards would make Left rewind and
    // Right fast-forward, so it is pinned here.
    const state = openFlashbackTimeline(createFlashbackTimeline(), 10);
    scrubFlashbackTimeline(state, 5);
    expect(nudgeFlashbackTimeline(state, SCRUB_STEP_SECONDS)).toBe(5.5);
    expect(nudgeFlashbackTimeline(state, -SCRUB_STEP_SECONDS)).toBe(5);
    // Walking off each end in turn lands exactly on the bounds.
    for (let i = 0; i < 100; i += 1) nudgeFlashbackTimeline(state, SCRUB_STEP_SECONDS);
    expect(state.secondsAgo).toBe(10);
    for (let i = 0; i < 100; i += 1) nudgeFlashbackTimeline(state, -SCRUB_STEP_SECONDS);
    expect(state.secondsAgo).toBe(0);
  });

  it("reopens at the new capacity rather than keeping the old head", () => {
    // The buffer grows as the race runs, so a reopen after a longer stint must
    // show the longer window, not a stale head from the previous open.
    const state = createFlashbackTimeline();
    openFlashbackTimeline(state, 5);
    scrubFlashbackTimeline(state, 1);
    cancelFlashbackTimeline(state);
    openFlashbackTimeline(state, 14);
    expect(state.capacity).toBe(14);
    expect(state.secondsAgo).toBe(14);
  });

  it("bumps its serial on every change so a UI knows to redraw", () => {
    const state = createFlashbackTimeline();
    const before = state.serial;
    openFlashbackTimeline(state, 10);
    expect(state.serial).toBeGreaterThan(before);
    const afterOpen = state.serial;
    scrubFlashbackTimeline(state, 5);
    expect(state.serial).toBeGreaterThan(afterOpen);
  });

  it("names the keys in the hint, and only while open", () => {
    const state = openFlashbackTimeline(createFlashbackTimeline(), 15);
    scrubFlashbackTimeline(state, 2);
    const hint = flashbackTimelineHint(state);
    expect(hint).toContain("2.0s");
    expect(hint).toContain("15.0s");
    expect(hint).toContain("ENTER");
    expect(hint).toContain("ESC");
  });
});

describe("the flash trace", () => {
  const step = 1 / 60;

  it("starts empty and reports no span", () => {
    const trace = createFlashbackTrace();
    expect(trace.spanSeconds()).toBe(0);
    expect(trace.readAt(0)).toBeNull();
    expect(buildFlashbackStrip(trace, 0, 60)).toEqual([]);
  });

  it("rate-limits to 10Hz however often it is fed", () => {
    // The caller pushes every physics step (60Hz). If this did not
    // rate-limit, a 15 second window would be 900 records instead of 150 and
    // the strip would be doing three times the work for no extra detail.
    const trace = createFlashbackTrace();
    for (let i = 0; i < 600; i += 1) {
      trace.record(step, { speedKmh: 100, throttle: 1, brake: 0, contact: false });
    }
    // 10 seconds at 10Hz is 100 samples plus the first.
    expect(trace.spanSeconds()).toBeCloseTo(9.9, 1);
  });

  it("holds a 15 second window without growing past its ring", () => {
    const trace = createFlashbackTrace();
    // 40 seconds of driving: the ring must stop at its capacity and keep
    // sliding, not grow without bound. An unbounded trace is a slow memory
    // leak in a long race.
    for (let i = 0; i < 60 * 40; i += 1) {
      trace.record(step, { speedKmh: 200, throttle: 1, brake: 0, contact: false });
    }
    expect(trace.spanSeconds()).toBeLessThanOrEqual(REWIND_CAPACITY_SECONDS);
    expect(trace.spanSeconds()).toBeGreaterThan(REWIND_CAPACITY_SECONDS - 0.5);
  });

  it("maps a read to the right sample, and to null past the start", () => {
    const trace = createFlashbackTrace();
    // Distinct speeds at a known rate, so the mapping is checkable exactly.
    for (let i = 0; i < 100; i += 1) {
      trace.record(1 / FLASHBACK_TRACE_HZ, { speedKmh: i, throttle: 0, brake: 0, contact: false });
    }
    expect(trace.readAt(0)?.speedKmh).toBe(99);
    expect(trace.readAt(1)?.speedKmh).toBe(89);
    expect(trace.readAt(5)?.speedKmh).toBe(49);
    // Past the beginning of the window there is nothing to read, and the
    // caller must be able to tell that from a genuine zero.
    expect(trace.readAt(50)).toBeNull();
  });

  it("keeps the throttle and brake bars independent", () => {
    // A trail-braking sample has both non-zero, and the strip has to show
    // that rather than collapsing them into one number.
    //
    // Compared with a tolerance, not toEqual: the trace stores into
    // Float32Array (one cache line per channel, no per-sample objects), and
    // 0.4 is not representable in 32-bit float. That quantization is
    // irrelevant to drawing a bar and would be wrong to spend an object per
    // sample to avoid.
    const trace = createFlashbackTrace();
    trace.record(1 / FLASHBACK_TRACE_HZ, { speedKmh: 200, throttle: 0.4, brake: 0.7, contact: true });
    const sample = trace.readAt(0);
    expect(sample).not.toBeNull();
    expect(sample!.speedKmh).toBeCloseTo(200, 1);
    expect(sample!.throttle).toBeCloseTo(0.4, 5);
    expect(sample!.brake).toBeCloseTo(0.7, 5);
    expect(sample!.contact).toBe(true);
  });

  it("clears completely for a new attempt", () => {
    const trace = createFlashbackTrace();
    for (let i = 0; i < 100; i += 1) {
      trace.record(1 / FLASHBACK_TRACE_HZ, { speedKmh: 100, throttle: 1, brake: 0, contact: false });
    }
    trace.clear();
    expect(trace.spanSeconds()).toBe(0);
    expect(trace.readAt(0)).toBeNull();
  });
});

describe("the strip", () => {
  /** A trace with a known shape: accelerating, braking, then a contact. */
  function shapedTrace() {
    const trace = createFlashbackTrace();
    for (let i = 0; i < 150; i += 1) {
      const phase = i / 150;
      trace.record(1 / FLASHBACK_TRACE_HZ, {
        speedKmh: phase < 0.5 ? phase * 600 : (1 - phase) * 600,
        throttle: phase < 0.5 ? 1 : 0,
        brake: phase < 0.5 ? 0 : 1,
        contact: i > 100 && i < 105,
      });
    }
    return trace;
  }

  it("produces one column per requested pixel, newest on the right", () => {
    const strip = buildFlashbackStrip(shapedTrace(), 0, 40);
    expect(strip).toHaveLength(40);
    // The newest sample is last, and it is the slowest (the trace decelerates
    // at the end), so the right-hand end must be lower than the middle.
    const middle = Math.floor(strip.length / 2);
    expect(strip[strip.length - 1].speed01).toBeLessThan(strip[middle].speed01);
  });

  it("normalises speed against a fixed reference, not the window's own max", () => {
    // Two strips of different stints have to be comparable, or a slow lap
    // would be scaled up into looking like a fast one.
    const strip = buildFlashbackStrip(shapedTrace(), 0, 10);
    for (const column of strip) {
      expect(column.speed01).toBeGreaterThanOrEqual(0);
      expect(column.speed01).toBeLessThanOrEqual(1);
    }
    // 300 km/h is most of the way to the 320 reference.
    const atFull = buildFlashbackStrip(
      (() => {
        const t = createFlashbackTrace();
        for (let i = 0; i < 20; i += 1) {
          t.record(1 / FLASHBACK_TRACE_HZ, { speedKmh: 300, throttle: 1, brake: 0, contact: false });
        }
        return t;
      })(),
      0,
      5
    );
    expect(atFull[0].speed01).toBeCloseTo(300 / FLASHBACK_STRIP_REFERENCE_KMH, 5);
  });

  it("marks the contact samples so an incident is visible on the strip", () => {
    const strip = buildFlashbackStrip(shapedTrace(), 0, 150);
    expect(strip.some((column) => column.contact)).toBe(true);
  });

  it("is bounded, so a wide request cannot cost unbounded work", () => {
    const trace = shapedTrace();
    expect(buildFlashbackStrip(trace, 0, 10000)).toHaveLength(240);
    expect(buildFlashbackStrip(trace, 0, 0)).toHaveLength(1);
  });

  it("writes the same strip in place, into a caller's own array", () => {
    // This is the form the HUD uses, and the reason it exists separately is
    // allocation: a 20Hz redraw must not build a fresh 96-element array. The
    // output has to match the allocating version exactly, and the caller's
    // array has to be the SAME object afterwards so the widget can keep it.
    const trace = shapedTrace();
    const allocating = buildFlashbackStrip(trace, 0, 30);
    const reused = Array.from({ length: 30 }, () => ({
      speed01: 0,
      throttle01: 0,
      brake01: 0,
      contact: false,
    }));
    const written = writeFlashbackStrip(trace, 0, reused);
    expect(written).toBe(30);
    expect(reused).toEqual(allocating);
    // A second call overwrites rather than appending.
    writeFlashbackStrip(trace, 0, reused);
    expect(reused).toHaveLength(30);
  });

  it("refuses to write into a zero-width array rather than looping forever", () => {
    expect(writeFlashbackStrip(shapedTrace(), 0, [])).toBe(0);
  });

  it("places the head correctly, moving left as the player goes back", () => {
    const span = 10;
    expect(flashStripHeadFraction(0, span, 100)).toBe(1);
    expect(flashStripHeadFraction(span, span, 100)).toBe(0);
    expect(flashStripHeadFraction(span / 2, span, 100)).toBeCloseTo(0.5, 5);
    // Degenerate cases must not divide by zero or produce NaN in a transform.
    expect(flashStripHeadFraction(5, 0, 100)).toBe(1);
    expect(flashStripHeadFraction(5, 10, 1)).toBe(1);
    expect(flashStripHeadFraction(999, 10, 100)).toBe(0);
  });
});
