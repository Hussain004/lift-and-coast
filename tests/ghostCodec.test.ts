import { describe, expect, it } from "vitest";
import {
  GHOST_FORMAT_VERSION,
  GHOST_HEADER_BYTES,
  GHOST_SAMPLE_HZ,
  GHOST_XZ_STEP_M,
  GHOST_Y_STEP_M,
  decodeGhost,
  encodeGhost,
  ghostDurationSeconds,
  ghostOrigin,
  type GhostCodecError,
} from "../lib/race/ghostCodec";
import {
  GHOST_DURATION_TOLERANCE_SECONDS,
  expectedGhostSampleCount,
  validateGhostUpload,
} from "../lib/race/ghostUploadGuard";
import type { GhostSample } from "../lib/race/ghostRecorder";

/**
 * Roadmap 11.9: the rival-ghost wire format and the upload guard.
 *
 * These are the pieces that have to be RIGHT BEFORE any storage exists, not
 * after: the format is what a future `ghosts` table gets designed around, and
 * the guard is the function a server-side validator will call. Getting either
 * wrong after the schema ships means migrating every stored blob.
 */

/**
 * A lap of `seconds` at `hz`, driving a CLOSED LOOP.
 *
 * Closed, not a straight line, and that matters: a real circuit returns to its
 * start, so its positions stay inside the measured +/-2048m int16 range. A
 * straight line at racing speed leaves that range in half a minute, and the
 * codec correctly clamps - so a straight-line fixture would have been testing
 * the clamp, not the round trip, and would have looked like a codec bug.
 */
function loopLap(seconds: number, hz = 60, radius = 800): GhostSample[] {
  const n = Math.round(seconds * hz);
  const samples: GhostSample[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / hz;
    const a = (t / seconds) * Math.PI * 2;
    samples.push({
      elapsedSeconds: t,
      position: { x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius },
      // Yaw follows the tangent, so the rotation channel is exercised too.
      rotation: { x: 0, y: Math.sin((a + Math.PI / 2) / 2), z: 0, w: Math.cos((a + Math.PI / 2) / 2) },
    });
  }
  return samples;
}

/** Straight-line trace, for the tests that specifically want an unbounded one. */
function straightLap(seconds: number, hz = 60): GhostSample[] {
  const n = Math.round(seconds * hz);
  const samples: GhostSample[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / hz;
    samples.push({
      elapsedSeconds: t,
      position: { x: t * 80, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
  }
  return samples;
}

const SILVERSTONE_CL = [
  [-500, 0, -300],
  [500, 0, 300],
] as const;

function isError(v: unknown): v is GhostCodecError {
  return typeof v === "object" && v !== null && "reason" in v;
}

describe("ghost origin", () => {
  it("centres on the circuit's bounding box, not the world origin", () => {
    // A circuit authored 1000m off the world origin would otherwise spend
    // most of the int16 range on the offset rather than on the lap.
    const o = ghostOrigin([
      [1000, 10, 2000],
      [3000, 30, 4000],
    ]);
    expect(o).toEqual({ x: 2000, y: 20, z: 3000 });
  });

  it("falls back to the origin for an empty centerline", () => {
    expect(ghostOrigin([])).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe("int16 range covers every shipped circuit", () => {
  it("holds the measured extents of all 30 circuits with headroom", () => {
    // The step sizes are only defensible if they clear the real data. These
    // are the measured extents (see the measurement note in ghostCodec.ts):
    // largest x span 2058m, z span 2756m, y span 112m. A circuit that
    // exceeded the range would wrap an int16 and teleport a ghost to the
    // opposite side of the world - silent, and catastrophic.
    const maxHalfExtentXz = 1378; // half of the 2756m z span
    const maxHalfExtentY = 62;
    const rangeXz = 32767 * GHOST_XZ_STEP_M;
    const rangeY = 32767 * GHOST_Y_STEP_M;
    expect(rangeXz).toBeGreaterThan(maxHalfExtentXz * 1.4);
    expect(rangeY).toBeGreaterThan(maxHalfExtentY * 4);
  });
});

describe("round trip", () => {
  it("reproduces positions to within the quantisation step", async () => {
    const samples = loopLap(90);
    const encoded = await encodeGhost(samples, SILVERSTONE_CL, 90_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);

    expect(decoded.samples.length).toBe(901);
    // Every decoded pose must sit within one step of the real recorded pose
    // for that instant. At 10Hz against a 60Hz recording, the 6x index is the
    // matching sample.
    for (const i of [100, 400, 700]) {
      const expected = samples[i * 6];
      const actual = decoded.samples[i];
      expect(Math.abs(actual.position.x - expected.position.x)).toBeLessThanOrEqual(GHOST_XZ_STEP_M);
      expect(Math.abs(actual.position.z - expected.position.z)).toBeLessThanOrEqual(GHOST_XZ_STEP_M);
      expect(Math.abs(actual.elapsedSeconds - expected.elapsedSeconds)).toBeLessThan(0.05);
    }
  });

  it("reproduces rotation, renormalised", async () => {
    const samples: GhostSample[] = [];
    for (let i = 0; i <= 600; i += 1) {
      const a = i * 0.01;
      samples.push({
        elapsedSeconds: i / 60,
        position: { x: Math.cos(a) * 400, y: 0, z: Math.sin(a) * 400 },
        // A normalised, rotating quaternion.
        rotation: { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) },
      });
    }
    const encoded = await encodeGhost(samples, SILVERSTONE_CL, 10_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    const q = decoded.samples[50].rotation;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 3);
  });

  it("stamps time from the index, never from the blob", async () => {
    // Time is implicit at 10Hz, which is what stops a forged blob claiming a
    // lap longer than its own trace.
    const encoded = await encodeGhost(loopLap(60), SILVERSTONE_CL, 60_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    decoded.samples.forEach((s, i) => {
      expect(s.elapsedSeconds).toBe(i / GHOST_SAMPLE_HZ);
    });
  });

  it("round-trips the origin and the lap time through the header", async () => {
    const encoded = await encodeGhost(loopLap(75), SILVERSTONE_CL, 75_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    expect(decoded.lapMs).toBe(75_000);
    expect(decoded.origin).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("gzips the sample block", async () => {
    // The size claim in the plan is 15-30KB per lap; uncompressed it would be
    // several times that, so this is the assertion that keeps the storage cost
    // honest.
    const encoded = await encodeGhost(loopLap(90), SILVERSTONE_CL, 90_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    expect(decoded.gzipped).toBe(true);
    const rawBytes = decoded.samples.length * 14;
    expect(encoded.length).toBeLessThan(rawBytes);
    // A real Spa-length lap stays in the plan's stated band.
    expect(encoded.length).toBeLessThan(30 * 1024);
  });
});

describe("resampling", () => {
  it("puts samples on an exact 10Hz grid whatever the record rate", async () => {
    for (const hz of [30, 60, 144]) {
      const encoded = await encodeGhost(loopLap(40, hz), SILVERSTONE_CL, 40_000);
      if (isError(encoded)) throw new Error(encoded.reason);
      const decoded = await decodeGhost(encoded);
      if (isError(decoded)) throw new Error(decoded.reason);
      // 40s at 10Hz is 401 slots; the count is independent of the record rate.
      expect(decoded.samples.length).toBe(401);
    }
  });

  it("keeps the final sample at the real end of the lap", async () => {
    // The closing pose is what the player sees at the line, so it must be the
    // recorded end of the lap and not a grid slot that fell short of it.
    const samples = loopLap(90);
    const encoded = await encodeGhost(samples, SILVERSTONE_CL, 90_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    const last = decoded.samples[decoded.samples.length - 1];
    const expected = samples[samples.length - 1];
    expect(last.position.x).toBeCloseTo(expected.position.x, 1);
  });

  it("does not manufacture samples past the end of the recording", async () => {
    // A recording that stops early must not be padded out to the claimed lap
    // time - that would make the duration check in the guard meaningless.
    const short = loopLap(20);
    const encoded = await encodeGhost(short, SILVERSTONE_CL, 90_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    expect(ghostDurationSeconds(decoded.samples.length)).toBeCloseTo(20, 1);
  });
});

describe("encode rejects rather than degrading", async () => {
  it("rejects a trace too short to be a lap", async () => {
    const result = await encodeGhost([straightLap(0.1)[0]], SILVERSTONE_CL, 100);
    expect(isError(result)).toBe(true);
  });

  it("rejects an empty trace", async () => {
    expect(isError(await encodeGhost([], SILVERSTONE_CL, 60_000))).toBe(true);
  });

  it("rejects a non-positive lap time", async () => {
    expect(isError(await encodeGhost(straightLap(60), SILVERSTONE_CL, 0))).toBe(true);
    expect(isError(await encodeGhost(straightLap(60), SILVERSTONE_CL, NaN))).toBe(true);
  });

  it("clamps an out-of-range position instead of wrapping it", async () => {
    // Wrapping is the catastrophic case: a ghost that teleports to the
    // antipode mid-lap. Clamping pins it at the edge of the world instead,
    // which is visibly wrong rather than silently insane.
    const far: GhostSample[] = [
      { elapsedSeconds: 0, position: { x: 1e7, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
      { elapsedSeconds: 1, position: { x: 1e7 + 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ];
    const encoded = await encodeGhost(far, SILVERSTONE_CL, 60_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    // Pinned at the +2048m edge, not wrapped to -2048m.
    expect(decoded.samples[0].position.x).toBeGreaterThan(2000);
  });
});

describe("decode rejects a hostile blob", () => {
  // The moment ghosts are shared these bytes are attacker-controlled. Every
  // one of these is a real failure mode of "trust the header".

  it("rejects a blob shorter than its header", async () => {
    const result = await decodeGhost(new Uint8Array(10));
    expect(isError(result)).toBe(true);
  });

  it("rejects bad magic", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    bad[0] = 0x00;
    expect(isError(await decodeGhost(bad))).toBe(true);
  });

  it("rejects a future format version instead of misreading it", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    bad[4] = GHOST_FORMAT_VERSION + 1;
    const result = await decodeGhost(bad);
    expect(isError(result)).toBe(true);
    if (isError(result)) expect(result.reason).toMatch(/version/i);
  });

  it("rejects a sample count the body cannot satisfy", async () => {
    // The classic header/body mismatch: claim 60000 samples, ship 400.
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    new DataView(bad.buffer).setUint16(8, 60_000, true);
    expect(isError(await decodeGhost(bad))).toBe(true);
  });

  it("rejects a count below two", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    new DataView(bad.buffer).setUint16(8, 1, true);
    expect(isError(await decodeGhost(bad))).toBe(true);
  });

  it("rejects a truncated body", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    expect(isError(await decodeGhost(good.subarray(0, GHOST_HEADER_BYTES + 5)))).toBe(true);
  });

  it("rejects a non-finite origin", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    new DataView(bad.buffer).setFloat32(14, Infinity, true);
    expect(isError(await decodeGhost(bad))).toBe(true);
  });

  it("rejects a body that is not valid gzip", async () => {
    const good = await encodeGhost(straightLap(60), SILVERSTONE_CL, 60_000);
    if (isError(good)) throw new Error(good.reason);
    const bad = Uint8Array.from(good);
    bad.fill(0, GHOST_HEADER_BYTES);
    expect(isError(await decodeGhost(bad))).toBe(true);
  });
});

describe("upload guard", () => {
  const lap = 90;
  const sampleCount = expectedGhostSampleCount(lap);

  /** A ghost that travelled exactly one lap of Silverstone (5300m) in 90s. */
  const TRACK_LENGTH = 5300;
  const honest = {
    lapSeconds: lap,
    sectorSeconds: [30, 60, 90],
    sampleCount,
    progressMeters: Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * TRACK_LENGTH),
    trackLengthMeters: TRACK_LENGTH,
  };

  it("accepts an honest upload and returns the trace's own duration", () => {
    const verdict = validateGhostUpload(honest);
    expect(verdict.ok).toBe(true);
    // The caller stores THIS, not the client's number - that is the guard's
    // practical effect.
    if (verdict.ok) expect(verdict.durationSeconds).toBeCloseTo(lap, 3);
  });

  it("catches a fast claimed time attached to a short trace", () => {
    // THE headline check from the plan. A player claiming a 60s lap while
    // shipping 30s of samples is the abuse this exists for.
    const verdict = validateGhostUpload({ ...honest, lapSeconds: 60, sampleCount: 301 });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/duration/i);
  });

  it("tolerates exactly the specified slack and no more", () => {
    const just = validateGhostUpload({
      ...honest,
      lapSeconds: lap + GHOST_DURATION_TOLERANCE_SECONDS * 0.5,
    });
    expect(just.ok).toBe(true);
    const over = validateGhostUpload({
      ...honest,
      lapSeconds: lap + GHOST_DURATION_TOLERANCE_SECONDS * 3,
    });
    expect(over.ok).toBe(false);
  });

  it("rejects sectors that are not strictly increasing", () => {
    const verdict = validateGhostUpload({ ...honest, sectorSeconds: [30, 60, 55] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/increasing/i);
  });

  it("rejects sectors that disagree with the lap time", () => {
    const verdict = validateGhostUpload({ ...honest, sectorSeconds: [10, 20, 30] });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/disagrees/i);
  });

  it("rejects a ghost that never moves", () => {
    // The other cheap forgery: the right amount of time, no ground covered.
    const verdict = validateGhostUpload({
      ...honest,
      progressMeters: new Array(sampleCount).fill(100),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/covers 0m/);
  });

  it("rejects a trace lifted from a shorter circuit", () => {
    // Half the lap's worth of travel on a full-length track: a trace that
    // would look fine against the wrong circuit.
    const verdict = validateGhostUpload({
      ...honest,
      progressMeters: Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * 1200),
    });
    expect(verdict.ok).toBe(false);
  });

  it("rejects a trace that ran on past the flag", () => {
    const verdict = validateGhostUpload({
      ...honest,
      progressMeters: Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * 9000),
    });
    expect(verdict.ok).toBe(false);
  });

  it("tolerates a lap that started a little off the line", () => {
    // Real laps are not exactly one lap of travel - rolling a few metres over
    // the line or running wide at the flag is normal and must not be rejected.
    const just = validateGhostUpload({
      ...honest,
      progressMeters: Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * TRACK_LENGTH * 1.03),
    });
    expect(just.ok).toBe(true);
    const over = validateGhostUpload({
      ...honest,
      progressMeters: Array.from({ length: sampleCount }, (_, i) => (i / (sampleCount - 1)) * TRACK_LENGTH * 1.2),
    });
    expect(over.ok).toBe(false);
  });

  it("rejects a non-positive track length", () => {
    expect(validateGhostUpload({ ...honest, trackLengthMeters: 0 }).ok).toBe(false);
  });

  it("rejects a lap time outside the plausible band", () => {
    expect(validateGhostUpload({ ...honest, lapSeconds: 5, sampleCount: 51 }).ok).toBe(false);
    expect(validateGhostUpload({ ...honest, lapSeconds: 5000, sampleCount: 50_001 }).ok).toBe(false);
  });

  it("rejects a non-positive or non-finite lap time", () => {
    expect(validateGhostUpload({ ...honest, lapSeconds: 0 }).ok).toBe(false);
    expect(validateGhostUpload({ ...honest, lapSeconds: -90 }).ok).toBe(false);
    expect(validateGhostUpload({ ...honest, lapSeconds: NaN }).ok).toBe(false);
  });

  it("rejects a nonsense sample count", async () => {
    const encoded = await encodeGhost(loopLap(90), SILVERSTONE_CL, 90_000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    // The guard is fed the DECODED count, never the header's, so a forged
    // header cannot talk its way past it.
    expect(validateGhostUpload({ ...honest, sampleCount: decoded.samples.length }).ok).toBe(true);
  });

  it("accepts a real encoded lap end to end", async () => {
    // The whole path, as a server would run it: decode, then guard.
    const seconds = 90;
    const encoded = await encodeGhost(loopLap(seconds), SILVERSTONE_CL, seconds * 1000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    const verdict = validateGhostUpload({
      lapSeconds: decoded.lapMs / 1000,
      sectorSeconds: [30, 60, 90],
      sampleCount: decoded.samples.length,
      progressMeters: decoded.samples.map((_, i) => (i / (decoded.samples.length - 1)) * 5300),
      trackLengthMeters: 5300,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("duration helper", () => {
  it("is the sample count minus one, at the nominal rate", () => {
    // One fewer interval than samples - a 2-sample ghost is one 10Hz step
    // long, not two.
    expect(ghostDurationSeconds(2)).toBeCloseTo(0.1, 6);
    expect(ghostDurationSeconds(901)).toBeCloseTo(90, 6);
  });
});
