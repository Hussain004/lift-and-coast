import { describe, expect, it } from "vitest";
import { createRewindBuffer, type RewindSample } from "../lib/race/rewindBuffer";

const TIMESTEP = 1 / 60;

function sampleAtX(x: number): RewindSample {
  return {
    position: { x, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    linvel: { x, y: 0, z: 0 },
    angvel: { x: 0, y: 0, z: 0 },
  };
}

describe("createRewindBuffer", () => {
  it("returns null when empty", () => {
    const buf = createRewindBuffer(5, TIMESTEP);
    expect(buf.sampleAt(0)).toBeNull();
    expect(buf.resumeFrom(0)).toBeNull();
    expect(buf.oldestAvailableSeconds()).toBe(0);
  });

  it("sampleAt(0) returns the most recently pushed sample", () => {
    const buf = createRewindBuffer(5, TIMESTEP);
    buf.push(sampleAtX(1));
    buf.push(sampleAtX(2));
    buf.push(sampleAtX(3));
    expect(buf.sampleAt(0)?.position.x).toBe(3);
  });

  it("sampleAt looks back the right number of steps", () => {
    const buf = createRewindBuffer(5, TIMESTEP);
    for (let i = 0; i < 10; i++) buf.push(sampleAtX(i));
    // 3 steps back from the latest (i=9) should be i=6.
    expect(buf.sampleAt(3 * TIMESTEP)?.position.x).toBe(6);
  });

  it("clamps to the oldest available sample when asked to go back further", () => {
    const buf = createRewindBuffer(5, TIMESTEP);
    buf.push(sampleAtX(1));
    buf.push(sampleAtX(2));
    expect(buf.sampleAt(100)?.position.x).toBe(1);
  });

  it("evicts samples beyond its capacity", () => {
    const capacitySeconds = 1;
    const buf = createRewindBuffer(capacitySeconds, TIMESTEP);
    const totalSteps = Math.round(capacitySeconds / TIMESTEP) + 20;
    for (let i = 0; i < totalSteps; i++) buf.push(sampleAtX(i));
    // The oldest surviving sample should be from 20 steps in, not 0.
    expect(buf.sampleAt(buf.oldestAvailableSeconds())?.position.x).toBe(20);
  });

  it("resumeFrom discards samples newer than the resume point", () => {
    const buf = createRewindBuffer(5, TIMESTEP);
    for (let i = 0; i < 10; i++) buf.push(sampleAtX(i));
    const resumed = buf.resumeFrom(3 * TIMESTEP);
    expect(resumed?.position.x).toBe(6);
    // The "future" (7, 8, 9) is gone - the latest sample is now the resume point.
    expect(buf.sampleAt(0)?.position.x).toBe(6);
    // Pushing after resume continues cleanly from there with no stale gap.
    buf.push(sampleAtX(100));
    expect(buf.sampleAt(0)?.position.x).toBe(100);
    expect(buf.sampleAt(TIMESTEP)?.position.x).toBe(6);
  });
});
