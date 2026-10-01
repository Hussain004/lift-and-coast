// Rival-ghost wire format (roadmap 11.9).
//
// A ghost is a few thousand position/rotation samples, which is far too much
// to keep as JSON in a database row and far too wasteful to upload raw. This
// module is the codec: it quantises a recorded lap to a fixed 10 Hz, packs it
// into int16s relative to the track's own origin, and gzips the result. Pure
// logic plus the platform's CompressionStream - no React, no network, no
// database - so the whole format is unit-testable, and the exact same
// functions are what a server-side validator would call.
//
// WHY THE SCALES ARE WHAT THEY ARE. The int16 step is not a guess: it is
// derived from the measured extents of all 30 shipped circuits (x span
// 2058m, z span 2756m, y span 112m). At 1/16m per step an int16 covers
// +/-2048m, which clears the largest circuit's half-extent (1378m) with
// ~48% headroom - enough that a car running wide at a corner does not wrap
// around and teleport to the antipode. That failure mode is silent and
// catastrophic (a ghost that suddenly drives through the infield), so the
// headroom is deliberate rather than tight. Y gets 1/64m per step because
// circuits are flat: 112m of total elevation change over a lap needs almost
// none of the range, and spending it on millimetre precision is free.
//
// Resolution lands at 6.25cm of position error per sample. At 10Hz that is
// 0.625 m/s of apparent speed noise, which is invisible on a translucent car
// and costs 14 bytes a sample instead of the 60 a float32 triple would.
//
// TIME IS IMPLICIT. Samples are on an exact 10 Hz grid from t=0, so there is
// no per-sample timestamp: the time of sample i is exactly i/10. That is
// what makes the format small enough to be worth shipping, and it is also
// what gives validateGhostUpload something real to check - see below.

import type { GhostSample } from "./ghostRecorder";

/** Nominal sample rate. The time of sample i is exactly i / GHOST_SAMPLE_HZ. */
export const GHOST_SAMPLE_HZ = 10;

/** Metres per int16 step, horizontal. Covers +/-2048m. See the note above. */
export const GHOST_XZ_STEP_M = 1 / 16;
/** Metres per int16 step, vertical. Covers +/-512m. */
export const GHOST_Y_STEP_M = 1 / 64;
/** Unit quaternion components map onto [-1, 1] over the signed 16-bit range. */
export const GHOST_QUAT_SCALE = 32767;

/** int16 samples per pose: x, y, z, then the quaternion's four components. */
const INTS_PER_POSE = 7;
const BYTES_PER_POSE = INTS_PER_POSE * 2;

/**
 * Header: magic, version, flags, then the metadata a validator needs before
 * it has decoded a single pose. Deliberately fixed-width and fixed-endian
 * (little) so a Postgres-side or Go-side reader can parse it without a
 * library.
 *
 *   0  4  magic "LCGH"
 *   4  1  format version
 *   5  1  flags (bit 0: the sample block is gzipped)
 *   6  2  reserved
 *   8  2  sample count (uint16)
 *  10  4  lap time in ms (uint32)
 *  14 12  origin x, y, z as float32 - the track centre this lap was packed against
 *  26  .. sample block
 */
export const GHOST_HEADER_BYTES = 26;
const MAGIC = 0x4847434c; // "LCGH" little-endian
export const GHOST_FORMAT_VERSION = 1;
const FLAG_GZIPPED = 1 << 0;
/** uint16 sample count, so a trace can be at most 65535/10 = 6553 seconds. */
const MAX_SAMPLES = 0xffff;

export interface GhostCodecError {
  ok: false;
  reason: string;
}

export interface DecodedGhost {
  /** Samples on the exact 10 Hz grid, with time filled in. */
  samples: GhostSample[];
  lapMs: number;
  /** The track centre the positions were packed against. */
  origin: { x: number; y: number; z: number };
  /** True when the sample block arrived gzipped. */
  gzipped: boolean;
}

function fail(reason: string): GhostCodecError {
  return { ok: false, reason };
}

function clampInt16(value: number): number {
  const r = Math.round(value);
  if (r > 32767) return 32767;
  if (r < -32768) return -32768;
  return r;
}

/**
 * The track centre a ghost is packed against: the bounding box centre of the
 * centerline. Centring on the circuit rather than on the world origin is what
 * buys the range headroom above - a circuit authored 1000m off the world
 * origin would otherwise waste most of the int16 range on the offset.
 *
 * The y centre uses the centerline's vertical extent rather than 0, so a
 * hill circuit spends its (generous) vertical range on the hill.
 */
export function ghostOrigin(
  centerline: readonly (readonly [number, number, number])[]
): { x: number; y: number; z: number } {
  if (centerline.length === 0) return { x: 0, y: 0, z: 0 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of centerline) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[2] > maxZ) maxZ = p[2];
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 };
}

/**
 * Resamples an arbitrary-rate recording onto the exact 10 Hz grid.
 *
 * The grid is anchored at t=0 and stepped forward, and the LAST grid slot is
 * always the final recorded sample rather than whatever fell nearest to it.
 * That last part is the one that matters visually: anchoring the grid to the
 * lap time instead would be tidier, but it would also make the trace's
 * duration equal the claimed lap time by construction, which would make the
 * duration check in validateGhostUpload vacuous. So the format stays honest
 * and the ghost's final pose can sit up to one grid step (100ms) short of the
 * line - at 80 m/s that is 8m, for 100ms, on a translucent car. Stated rather
 * than hidden, because the alternative is a validator that cannot fail.
 */
function resampleToGrid(samples: readonly GhostSample[]): GhostSample[] {
  if (samples.length === 0) return [];
  const out: GhostSample[] = [];
  let cursor = 0;
  const lastIndex = samples.length - 1;
  for (let i = 0; ; i += 1) {
    const t = i / GHOST_SAMPLE_HZ;
    if (i >= MAX_SAMPLES) break;
    if (t >= samples[lastIndex].elapsedSeconds) {
      out.push(samples[lastIndex]);
      break;
    }
    // Advance to the pair straddling t. The recording is monotonic in time, so
    // a forward scan is correct and cheap.
    while (cursor < lastIndex && samples[cursor + 1].elapsedSeconds <= t) cursor += 1;
    const a = samples[cursor];
    const b = samples[Math.min(cursor + 1, lastIndex)];
    const span = b.elapsedSeconds - a.elapsedSeconds;
    const f = span <= 0 ? 0 : (t - a.elapsedSeconds) / span;
    out.push({
      elapsedSeconds: t,
      position: {
        x: a.position.x + (b.position.x - a.position.x) * f,
        y: a.position.y + (b.position.y - a.position.y) * f,
        z: a.position.z + (b.position.z - a.position.z) * f,
      },
      rotation: nlerp(a.rotation, b.rotation, f),
    });
  }
  return out;
}

function nlerp(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
  t: number
): { x: number; y: number; z: number; w: number } {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1;
  const x = a.x + (sign * b.x - a.x) * t;
  const y = a.y + (sign * b.y - a.y) * t;
  const z = a.z + (sign * b.z - a.z) * t;
  const w = a.w + (sign * b.w - a.w) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}

/**
 * Quantise + pack + gzip. Returns the bytes to store, or a structured failure.
 *
 * Rejects rather than silently degrading: a ghost that cannot be represented
 * is a ghost that would replay wrongly, and a wrong ghost is worse than no
 * ghost because the player trusts it.
 */
export async function encodeGhost(
  samples: readonly GhostSample[],
  centerline: readonly (readonly [number, number, number])[],
  lapMs: number
): Promise<Uint8Array | GhostCodecError> {
  if (samples.length < 2) return fail("a ghost needs at least two samples");
  if (!Number.isFinite(lapMs) || lapMs <= 0) return fail("lap time must be a positive number of ms");

  const grid = resampleToGrid(samples);
  if (grid.length < 2) return fail("resampling produced fewer than two samples");
  if (grid.length > MAX_SAMPLES) {
    return fail(`a ${GHOST_SAMPLE_HZ}Hz trace of this lap exceeds the ${MAX_SAMPLES}-sample format limit`);
  }

  const origin = ghostOrigin(centerline);
  const body = new ArrayBuffer(grid.length * BYTES_PER_POSE);
  const view = new DataView(body);
  for (let i = 0; i < grid.length; i += 1) {
    const s = grid[i];
    const o = i * BYTES_PER_POSE;
    view.setInt16(o, clampInt16((s.position.x - origin.x) / GHOST_XZ_STEP_M), true);
    view.setInt16(o + 2, clampInt16((s.position.y - origin.y) / GHOST_Y_STEP_M), true);
    view.setInt16(o + 4, clampInt16((s.position.z - origin.z) / GHOST_XZ_STEP_M), true);
    view.setInt16(o + 6, clampInt16(s.rotation.x * GHOST_QUAT_SCALE), true);
    view.setInt16(o + 8, clampInt16(s.rotation.y * GHOST_QUAT_SCALE), true);
    view.setInt16(o + 10, clampInt16(s.rotation.z * GHOST_QUAT_SCALE), true);
    view.setInt16(o + 12, clampInt16(s.rotation.w * GHOST_QUAT_SCALE), true);
  }

  const packed = new Uint8Array(body);
  // CompressionStream is a hard requirement rather than a nicety: this is a
  // 10-30KB payload per upload, and uncompressed it would dominate the table.
  // It is present in every browser this project targets and in Node 18+, so
  // there is no fallback path to maintain - and a silent "ship it raw" branch
  // is exactly the kind of thing that gets forgotten until it is a 10x bill.
  const compressed = await gzip(packed);
  if (compressed === null) return fail("this environment cannot gzip (no CompressionStream)");

  const out = new Uint8Array(GHOST_HEADER_BYTES + compressed.length);
  const head = new DataView(out.buffer);
  head.setUint32(0, MAGIC, true);
  head.setUint8(4, GHOST_FORMAT_VERSION);
  head.setUint8(5, FLAG_GZIPPED);
  head.setUint16(6, 0, true);
  head.setUint16(8, grid.length, true);
  head.setUint32(10, Math.round(lapMs), true);
  head.setFloat32(14, origin.x, true);
  head.setFloat32(18, origin.y, true);
  head.setFloat32(22, origin.z, true);
  out.set(compressed, GHOST_HEADER_BYTES);
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Unpack. Every structural check is here rather than at the call sites,
 * because the input is attacker-controlled the moment ghosts are shared: a
 * truncated blob, a wrong magic, a hostile sample count or a short body must
 * all come back as a failure, never as a half-built sample array that a caller
 * might index into.
 */
export async function decodeGhost(bytes: Uint8Array): Promise<DecodedGhost | GhostCodecError> {
  if (bytes.length < GHOST_HEADER_BYTES) return fail("ghost blob is shorter than its header");
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.getUint32(0, true) !== MAGIC) return fail("not a ghost blob (bad magic)");
  const version = head.getUint8(4);
  if (version !== GHOST_FORMAT_VERSION) {
    return fail(`unsupported ghost format version ${version}`);
  }
  const flags = head.getUint8(5);
  const count = head.getUint16(8, true);
  const lapMs = head.getUint32(10, true);
  const origin = {
    x: head.getFloat32(14, true),
    y: head.getFloat32(18, true),
    z: head.getFloat32(22, true),
  };
  if (count < 2) return fail("ghost blob declares fewer than two samples");
  if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(origin.z)) {
    return fail("ghost blob has a non-finite origin");
  }

  const body = bytes.subarray(GHOST_HEADER_BYTES);
  const raw = (flags & FLAG_GZIPPED) !== 0 ? await gunzip(body) : body;
  if (raw === null) return fail("ghost blob could not be decompressed");
  if (raw.length < count * BYTES_PER_POSE) {
    return fail("ghost blob body is shorter than its declared sample count");
  }

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const samples: GhostSample[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const o = i * BYTES_PER_POSE;
    samples[i] = {
      // Recomputed, never read from the blob: the time IS the index, which is
      // what stops a forged blob from claiming a lap that is longer than its
      // own trace.
      elapsedSeconds: i / GHOST_SAMPLE_HZ,
      position: {
        x: view.getInt16(o, true) * GHOST_XZ_STEP_M + origin.x,
        y: view.getInt16(o + 2, true) * GHOST_Y_STEP_M + origin.y,
        z: view.getInt16(o + 4, true) * GHOST_XZ_STEP_M + origin.z,
      },
      rotation: normalizeQuat({
        x: view.getInt16(o + 6, true) / GHOST_QUAT_SCALE,
        y: view.getInt16(o + 8, true) / GHOST_QUAT_SCALE,
        z: view.getInt16(o + 10, true) / GHOST_QUAT_SCALE,
        w: view.getInt16(o + 12, true) / GHOST_QUAT_SCALE,
      }),
    };
  }
  return { samples, lapMs, origin, gzipped: (flags & FLAG_GZIPPED) !== 0 };
}

/**
 * Quantisation costs a little precision, so a decoded quaternion can come
 * back very slightly off unit length. Normalising here (rather than trusting
 * the stored value) keeps a long ghost from drifting, because three.js
 * renormalises too but compounds the error into the visual result over
 * thousands of frames.
 */
function normalizeQuat(q: { x: number; y: number; z: number; w: number }) {
  const len = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(len) || len === 0) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len };
}

/** The duration a decoded trace actually spans, in seconds. */
export function ghostDurationSeconds(sampleCount: number): number {
  return (sampleCount - 1) / GHOST_SAMPLE_HZ;
}
