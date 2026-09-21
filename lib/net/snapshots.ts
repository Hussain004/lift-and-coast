// Plan section 16 (online multiplayer): snapshot interpolation. The host
// broadcasts full car snapshots at SNAPSHOT_HZ; guests render at display
// rate, so each remote car keeps a small ring of timestamped snapshots and
// samples between the two bracketing a render time INTERP_DELAY_MS in the
// past. The delay is the whole trick: it guarantees bracketed samples
// exist even with jitter, at the cost of remote cars trailing reality by
// a tenth of a second - standard for casual racing, and documented on the
// tin. Pure math over caller-owned buffers (no React, no clock reads
// inside), so it is unit-testable with synthetic timestamps.

export const SNAPSHOT_HZ = 15;
export const INTERP_DELAY_MS = 120;
/** Snapshots older than this are useless for interpolation - drop them. */
export const SNAPSHOT_TTL_MS = 1000;
/** Input upload rate guest -> host (see NetClient). */
export const INPUT_HZ = 30;
/**
 * Pose upload rate guest -> host (see NetClient/NetHost's "pose" message).
 * The host simulates a guest's car from inputs; this slower stream is the
 * guest's own truth for its car, used only to correct gross drift (an
 * input-starved stretch, a divergent contact) - so a low rate is plenty
 * and the correction is a nudge, never a visible snap.
 */
export const POSE_HZ = 10;

export interface TimedSnapshot<T> {
  atMs: number;
  state: T;
}

/** Pushes a sample, dropping anything older than the TTL. */
export function pushSnapshot<T>(buffer: TimedSnapshot<T>[], atMs: number, state: T): void {
  buffer.push({ atMs, state });
  while (buffer.length > 0 && atMs - buffer[0].atMs > SNAPSHOT_TTL_MS) {
    buffer.shift();
  }
}

export interface CarPose {
  position: [number, number, number];
  rotation: [number, number, number, number];
  linvel: [number, number, number];
}

/**
 * Interpolates a pose at `atMs`: linear for position/velocity, normalized
 * lerp for the quaternion (angles stay small between 15Hz snapshots, so
 * full slerp buys nothing). Returns null when unbracketed (too few
 * samples, or the target predates the buffer after a stall) - callers
 * hold the last good pose instead of extrapolating into a guess.
 */
export function samplePose(
  buffer: readonly TimedSnapshot<CarPose>[],
  atMs: number
): CarPose | null {
  const bracket = bracketSnapshots(buffer, atMs);
  if (bracket === null) return null;
  if ("exact" in bracket) return bracket.exact;
  return interpolatePose(bracket.a.state, bracket.b.state, bracket.u);
}

/** A bracketed interval (or an exact endpoint hit) for interpolation. */
export type SnapshotBracket<T> =
  | { exact: T }
  | { a: TimedSnapshot<T>; b: TimedSnapshot<T>; u: number };

/** Finds the two samples bracketing `atMs`, or an endpoint, or null. */
export function bracketSnapshots<T>(
  buffer: readonly TimedSnapshot<T>[],
  atMs: number
): SnapshotBracket<T> | null {
  if (buffer.length === 0) return null;
  if (atMs <= buffer[0].atMs) return { exact: buffer[0].state };
  const last = buffer[buffer.length - 1];
  if (atMs >= last.atMs) return null;
  let k = 0;
  while (k + 1 < buffer.length && buffer[k + 1].atMs <= atMs) k++;
  const a = buffer[k];
  const b = buffer[k + 1];
  const span = b.atMs - a.atMs;
  return { a, b, u: span <= 0 ? 0 : (atMs - a.atMs) / span };
}

/**
 * Interpolates between two poses: linear for position/velocity, normalized
 * quaternion lerp for rotation. At 15Hz the yaw step between snapshots is
 * a few degrees even mid-corner, so this agrees with slerp to well under
 * a pixel - slerp would cost real math per car per frame for no visible
 * gain.
 */
export function interpolatePose(a: CarPose, b: CarPose, u: number): CarPose {
  const lerp3 = (
    p: [number, number, number],
    q: [number, number, number]
  ): [number, number, number] => [
    p[0] + (q[0] - p[0]) * u,
    p[1] + (q[1] - p[1]) * u,
    p[2] + (q[2] - p[2]) * u,
  ];
  const qa = a.rotation;
  const qb = b.rotation;
  const qr: [number, number, number, number] = [
    qa[0] + (qb[0] - qa[0]) * u,
    qa[1] + (qb[1] - qa[1]) * u,
    qa[2] + (qb[2] - qa[2]) * u,
    qa[3] + (qb[3] - qa[3]) * u,
  ];
  const len = Math.hypot(qr[0], qr[1], qr[2], qr[3]) || 1;
  return {
    position: lerp3(a.position, b.position),
    rotation: [qr[0] / len, qr[1] / len, qr[2] / len, qr[3] / len],
    linvel: lerp3(a.linvel, b.linvel),
  };
}

/**
 * Render timestamp for interpolation: wall clock minus the delay budget.
 * A single function so host and guest agree on the convention - and so
 * tests pin it.
 */
export function renderTimestamp(nowMs: number): number {
  return nowMs - INTERP_DELAY_MS;
}
