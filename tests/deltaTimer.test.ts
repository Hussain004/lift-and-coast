import { describe, expect, it } from "vitest";
import { MAX_RECORDING_SAMPLES, createDeltaTracker, formatDelta } from "../lib/race/deltaTimer";

describe("createDeltaTracker", () => {
  it("reports no delta until a reference lap exists", () => {
    const tracker = createDeltaTracker();
    expect(tracker.recordSample(0, 0)).toBeNull();
    expect(tracker.recordSample(100, 5)).toBeNull();
    // First lap completes and becomes the reference - not compared against
    // itself.
    tracker.endLap(10, 200, true);
    expect(tracker.recordSample(0, 0)).toBeCloseTo(0, 5);
  });

  it("compares the current lap against the recorded best lap at the same progress", () => {
    const tracker = createDeltaTracker();
    // Reference lap: 0m at t=0, 100m at t=10, ends (200m) at t=20.
    tracker.recordSample(0, 0);
    tracker.recordSample(100, 10);
    tracker.endLap(20, 200, true);

    // Next lap reaches 100m at t=9 - a second ahead of the reference.
    const delta = tracker.recordSample(100, 9);
    expect(delta).toBeCloseTo(-1, 5);
  });

  it("interpolates between reference samples for progress between recorded points", () => {
    const tracker = createDeltaTracker();
    tracker.recordSample(0, 0);
    tracker.endLap(10, 100, true);

    // Halfway between the two reference samples, at exactly reference pace.
    const delta = tracker.recordSample(50, 5);
    expect(delta).toBeCloseTo(0, 5);
  });

  it("does not corrupt the reference's tail with the new lap's reset time", () => {
    const tracker = createDeltaTracker();
    tracker.recordSample(0, 0);
    tracker.recordSample(90, 9);
    tracker.endLap(10, 100, true);
    // Immediately after ending, the new lap's first sample must not be
    // mistaken for the reference's own finish - the reference's end (100m,
    // t=10) must still hold.
    const delta = tracker.recordSample(100, 0.01);
    expect(delta).toBeCloseTo(0.01 - 10, 5);
  });

  it("only adopts a completed lap as the new reference when it was a new best", () => {
    const tracker = createDeltaTracker();
    tracker.recordSample(0, 0);
    tracker.endLap(10, 100, true);

    // A slower lap that finishes without being a new best must not replace
    // the faster reference.
    tracker.recordSample(0, 0);
    tracker.endLap(20, 100, false);

    const delta = tracker.recordSample(100, 10);
    expect(delta).toBeCloseTo(0, 5);
  });

  it("never adopts an overlong lap as the reference, even as a first-ever best", () => {
    const tracker = createDeltaTracker();
    for (let i = 0; i < MAX_RECORDING_SAMPLES + 10; i++) {
      tracker.recordSample(i, i);
    }
    // No prior best exists, so this would otherwise count as a new best.
    tracker.endLap(MAX_RECORDING_SAMPLES + 10, MAX_RECORDING_SAMPLES + 10, true);

    expect(tracker.recordSample(0, 0)).toBeNull();
  });
});

describe("formatDelta", () => {
  it("shows a leading sign and three decimals", () => {
    expect(formatDelta(2.3456)).toBe("+2.346");
    expect(formatDelta(-0.5)).toBe("-0.500");
    expect(formatDelta(0)).toBe("0.000");
  });

  it("is blank when there is no reference yet", () => {
    expect(formatDelta(null)).toBe("");
  });
});
