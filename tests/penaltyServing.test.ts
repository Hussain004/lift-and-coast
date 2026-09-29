import { describe, expect, it } from "vitest";
import { createServeState, queuePenalty, servePrompt, stepServe, STOP_GO_HOLD_SECONDS } from "../lib/race/penaltyServing";

const drive = { inBox: false, speedMs: 20, dt: 0.1 };

describe("penalty serving", () => {
  it("serves a drive-through only when the car leaves the pit lane", () => {
    const s = createServeState();
    queuePenalty(s, "drive-through", 20);
    expect(stepServe(s, { ...drive, inLane: false })).toBeNull();
    expect(stepServe(s, { ...drive, inLane: true })).toBeNull();
    expect(servePrompt(s, { inLane: true, inBox: false })).toContain("EXIT");
    expect(stepServe(s, { ...drive, inLane: false })?.seconds).toBe(20);
    expect(s.queue).toHaveLength(0);
  });

  it("serves a stop-go after a full stationary hold in the box", () => {
    const s = createServeState();
    queuePenalty(s, "stop-go", 30);
    let served = null;
    for (let t = 0; t < 12 && !served; t += 0.1) {
      served = stepServe(s, { inLane: true, inBox: true, speedMs: 0, dt: 0.1 });
      if (t < STOP_GO_HOLD_SECONDS - 0.5) expect(served).toBeNull();
    }
    expect(served?.kind).toBe("stop-go");
  });

  it("does not count a stop-go while rolling or outside the box, and resets on leaving", () => {
    const s = createServeState();
    queuePenalty(s, "stop-go", 30);
    for (let i = 0; i < 50; i++) expect(stepServe(s, { inLane: true, inBox: true, speedMs: 5, dt: 0.1 })).toBeNull();
    for (let i = 0; i < 50; i++) stepServe(s, { inLane: true, inBox: true, speedMs: 0, dt: 0.1 });
    stepServe(s, { inLane: true, inBox: false, speedMs: 0, dt: 0.1 });
    expect(s.stopSeconds).toBe(0);
  });

  it("is silent with nothing pending", () => {
    const s = createServeState();
    expect(stepServe(s, { inLane: true, inBox: true, speedMs: 0, dt: 1 })).toBeNull();
    expect(servePrompt(s, { inLane: false, inBox: false })).toBe("");
  });
});
