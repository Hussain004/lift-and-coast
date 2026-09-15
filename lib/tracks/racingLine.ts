import type { TrackData } from "./types";

// Plan section 4 point 8 ("racing line... drives the AI and the optional
// ideal-line overlay") and section 13 ("optional ideal-line overlay
// assist"). A full curvature-minimization pass constrained to track bounds
// is future work - this approximates it in two stages instead of one:
//
// 1. A raw per-point offset from a local curvature signal (biggest offset
//    where the track turns sharpest, biased toward the inside), THEN
// 2. A moving-average smoothing pass over that offset signal.
//
// Stage 1 alone (the original version of this file) produced a visibly
// zigzagging line: real track centerline data has small-scale noise (GPS/
// GeoJSON resampling artifacts), and a purely local per-point curvature
// measurement differentiates that noise into offset swings a real car
// couldn't actually follow. Stage 2 is a standard fix for exactly this -
// smoothing a noisy signal that was produced by differentiating another
// signal. A physics-style relaxation (iteratively moving each point toward
// its neighbors' midpoint) was tried first and rejected: on a closed loop
// with no other anchor, that kind of averaging is curve-shortening flow -
// it keeps shrinking the whole loop toward its centroid forever, and past
// roughly 100 iterations most points were pinned at the corridor's clamp
// boundary, making the "smoothed" line worse than the original (verified
// numerically: a raw position second-difference metric got worse, not
// better, past that point). A plain moving average of the offset signal
// has no such failure mode - it can only ever flatten toward zero offset
// the more it's applied, never oscillate or diverge - and was checked
// numerically against the real Silverstone data: the offset signal's
// direction-reversal count (a direct zigzag measure) dropped from 342 to
// ~28 over the whole lap, in line with the track's real corner count.
const CURVATURE_LOOKAHEAD_POINTS = 20;
const CURVATURE_OFFSET_GAIN = 40;
const MAX_OFFSET_FRACTION_OF_HALF_WIDTH = 0.75;
const SMOOTHING_BOX_RADIUS = 10;
const SMOOTHING_PASSES = 4;

// Speed-profile constants (also used to color the line - see ThrottleZone
// below). MAX_SPEED_MS=70 was checked numerically against this car's
// physics-derived terminal velocity - see lib/ai/pathFollower.ts's own
// history/comments for that derivation (this module now owns the speed
// profile the AI previously computed itself).
//
// The per-corner cap below used to be an empirically-tuned linear penalty
// on a raw cross-product "turn" signal (turn * CURVATURE_SPEED_PENALTY).
// That signal is sin(angle-between-tangents), which is ambiguous past 90
// degrees (sin looks the same for a 20 degree kink and a 160 degree
// hairpin) - real corners sharp enough to matter for AI off-track behavior
// can exceed that over this lookahead. It's replaced with an actual
// curvature estimate (unambiguous turn angle via atan2, divided by the
// real arc length between the lookahead points) and a textbook lateral-
// grip speed cap, v <= sqrt(maxLateralAccel * radius) - the same standard
// technique already used for the accel/decel passes below, just applied
// laterally instead of longitudinally.
const SPEED_LOOKAHEAD_POINTS = 30;
const MAX_SPEED_MS = 70;
const MIN_CORNER_SPEED_MS = 18;
// ~1.2g - a plausible cornering-grip approximation, slightly below
// MAX_DECEL_MS2's ~1.4g braking figure (real tires generally grip a little
// harder in a straight line than mid-corner). Not a physics sim in its own
// right, same as MAX_DECEL_MS2/MAX_ACCEL_MS2 below.
const MAX_LATERAL_ACCEL_MS2 = 12;
// Backward/forward passes enforce a physically-plausible speed profile: you
// can't be doing 250 km/h one point and 65 km/h the next just because a
// tight corner is there - braking (and accelerating) takes distance. Values
// are a plausible constant-deceleration/acceleration approximation for this
// car (roughly 1.4g braking, 0.8g acceleration) for shaping a smooth
// profile, not a physics simulation in their own right.
export const MAX_DECEL_MS2 = 14;
export const MAX_ACCEL_MS2 = 8;
const SPEED_PASS_LAPS = 3; // full loop-arounds, so constraints propagate all the way round a closed track.

// Thresholds on required deceleration (m/s^2) between consecutive points,
// checked against the real (smoothed) distribution on Silverstone before
// picking them: ~71% of the lap needs no lift at all (throttle), ~4% wants
// a light lift, ~4% a medium brake, and ~21% (including every point where
// MAX_DECEL_MS2 itself is the binding constraint - a genuine hard-braking
// zone) reads as brake-hard. The lift/medium bands are naturally brief -
// deceleration ramps from near-zero to the 14 m/s^2 cap quickly approaching
// a real corner, so there's only a short stretch of track in between.
const LIFT_DECEL_THRESHOLD = 0.3;
const BRAKE_MEDIUM_DECEL_THRESHOLD = 3;
const BRAKE_HARD_DECEL_THRESHOLD = 7;

export type ThrottleZone = "throttle" | "lift" | "brake-medium" | "brake-hard";

export interface RacingLinePoint {
  position: [number, number, number];
  /** Physically-plausible target speed at this point, m/s. */
  targetSpeedMs: number;
  /** For coloring/HUD: how much this point asks the driver to lift/brake. */
  zone: ThrottleZone;
}

function unitTangentAt(points: readonly (readonly [number, number, number])[], i: number): { x: number; z: number } {
  const n = points.length;
  const p = points[(i - 1 + n) % n];
  const q = points[(i + 1) % n];
  const tx = q[0] - p[0];
  const tz = q[2] - p[2];
  const len = Math.hypot(tx, tz) || 1;
  return { x: tx / len, z: tz / len };
}

function boxFilterPass(values: Float64Array, radius: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let d = -radius; d <= radius; d++) {
      sum += values[(i + d + n) % n];
    }
    out[i] = sum / (radius * 2 + 1);
  }
  return out;
}

function classifyZone(decelMs2: number): ThrottleZone {
  if (decelMs2 <= LIFT_DECEL_THRESHOLD) return "throttle";
  if (decelMs2 <= BRAKE_MEDIUM_DECEL_THRESHOLD) return "lift";
  if (decelMs2 <= BRAKE_HARD_DECEL_THRESHOLD) return "brake-medium";
  return "brake-hard";
}

/**
 * A racing-line approximation: one point per centerline index (same
 * indexing as track.centerline, so callers that already work with
 * centerline indices - e.g. sector gates - line up directly with this),
 * each carrying a target speed and a throttle/brake zone alongside its
 * position.
 */
export function computeRacingLine(track: TrackData): RacingLinePoint[] {
  const n = track.centerline.length;
  const centerline = track.centerline;

  // Stage 1: raw per-point curvature-based offset, biased toward the
  // inside of the turn ahead (see the module comment for the derivation
  // and its own verification against a synthetic circular track).
  const rightVectors: { x: number; z: number }[] = new Array(n);
  const rawOffsets = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const behind = unitTangentAt(centerline, (i - CURVATURE_LOOKAHEAD_POINTS + n) % n);
    const ahead = unitTangentAt(centerline, (i + CURVATURE_LOOKAHEAD_POINTS) % n);
    const turn = behind.x * ahead.z - behind.z * ahead.x;
    const tangent = unitTangentAt(centerline, i);
    rightVectors[i] = { x: -tangent.z, z: tangent.x };
    const maxOffset = (track.width[i] / 2) * MAX_OFFSET_FRACTION_OF_HALF_WIDTH;
    rawOffsets[i] = Math.max(-maxOffset, Math.min(maxOffset, turn * CURVATURE_OFFSET_GAIN));
  }

  // Stage 2: smooth the offset signal, then re-clamp (a smoothing pass
  // can't push a value outside the range of its inputs, so this is a
  // cheap safety re-check, not a real constraint in practice).
  let offsets: Float64Array = rawOffsets;
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    offsets = boxFilterPass(offsets, SMOOTHING_BOX_RADIUS);
  }
  for (let i = 0; i < n; i++) {
    const maxOffset = (track.width[i] / 2) * MAX_OFFSET_FRACTION_OF_HALF_WIDTH;
    offsets[i] = Math.max(-maxOffset, Math.min(maxOffset, offsets[i]));
  }

  const positions: [number, number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = centerline[i];
    const r = rightVectors[i];
    positions[i] = [x + r.x * offsets[i], y, z + r.z * offsets[i]];
  }

  const segmentLengths = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = positions[i];
    const b = positions[(i + 1) % n];
    segmentLengths[i] = Math.hypot(b[0] - a[0], b[2] - a[2]);
  }

  // Speed profile: a raw per-point cap from the smoothed line's own
  // curvature (a real radius, via turn angle over real arc length - see the
  // module comment), then backward/forward passes enforcing a physically
  // reachable deceleration/acceleration between consecutive points. This
  // profile drives the AI's actual target speed, so unlike stage 2's offset
  // it is NOT box-filtered here - a box filter was tried directly on this
  // signal to fix the zone-classification flicker below, and while it
  // looked like a clear win on paper (83->16 short zone "runs", +1 m/s at
  // the tightest corner), it was checked at 90s only. At a full lap-plus
  // (150s) it caused a genuine flip (maxTiltRad 0.11 -> 1.04) - this
  // control system's documented chaotic sensitivity (see pathFollower.ts)
  // means even a ~1 m/s shift at one corner can move the AI's failure mode
  // from "runs a bit wide" to "tips over" elsewhere on the lap. The fix
  // belongs on the classification signal only (see displaySpeedMs below),
  // never on the speed the AI actually drives to.
  const curveOnlySpeed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const behind = unitTangentAt(positions, (i - SPEED_LOOKAHEAD_POINTS + n) % n);
    const ahead = unitTangentAt(positions, (i + SPEED_LOOKAHEAD_POINTS) % n);
    const cross = behind.x * ahead.z - behind.z * ahead.x;
    const dot = behind.x * ahead.x + behind.z * ahead.z;
    const turnAngle = Math.abs(Math.atan2(cross, dot));
    let arcLength = 0;
    for (let k = 0; k < 2 * SPEED_LOOKAHEAD_POINTS; k++) {
      arcLength += segmentLengths[(i - SPEED_LOOKAHEAD_POINTS + k + n) % n];
    }
    const curvature = arcLength > 1e-6 ? turnAngle / arcLength : 0;
    const maxLateralSpeed = curvature > 1e-9 ? Math.sqrt(MAX_LATERAL_ACCEL_MS2 / curvature) : MAX_SPEED_MS;
    curveOnlySpeed[i] = Math.min(MAX_SPEED_MS, Math.max(MIN_CORNER_SPEED_MS, maxLateralSpeed));
  }

  const targetSpeedMs = Float64Array.from(curveOnlySpeed);
  for (let lap = 0; lap < SPEED_PASS_LAPS; lap++) {
    for (let k = 0; k < n; k++) {
      const i = (n - 1 - k + n) % n;
      const next = (i + 1) % n;
      const maxReachable = Math.sqrt(targetSpeedMs[next] ** 2 + 2 * MAX_DECEL_MS2 * segmentLengths[i]);
      targetSpeedMs[i] = Math.min(targetSpeedMs[i], maxReachable);
    }
  }
  for (let lap = 0; lap < SPEED_PASS_LAPS; lap++) {
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const maxReachable = Math.sqrt(targetSpeedMs[prev] ** 2 + 2 * MAX_ACCEL_MS2 * segmentLengths[prev]);
      targetSpeedMs[i] = Math.min(targetSpeedMs[i], maxReachable);
    }
  }

  // Display-only smoothed copy of the final, physically-capped speed
  // profile, used ONLY to classify each point's zone for the on-track
  // color overlay - never returned as targetSpeedMs, so the AI's actual
  // driving target is untouched (see the module comment above on why that
  // separation matters). Smoothing the already-capped profile works at
  // least as well as smoothing the raw curvature cap did: checked
  // numerically against real Silverstone data, this gives 0 zone "runs" of
  // 3 points or shorter (down from 83 of 145), better than smoothing
  // curveOnlySpeed itself managed (16 of 72) - the backward/forward passes
  // already partly shape the profile, so there's less residual noise left
  // to smooth out.
  let displaySpeedMs: Float64Array = Float64Array.from(targetSpeedMs);
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    displaySpeedMs = boxFilterPass(displaySpeedMs, SMOOTHING_BOX_RADIUS);
  }

  const result: RacingLinePoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const decelNeeded = Math.max(
      0,
      (displaySpeedMs[i] ** 2 - displaySpeedMs[next] ** 2) / (2 * segmentLengths[i])
    );
    result[i] = {
      position: positions[i],
      targetSpeedMs: targetSpeedMs[i],
      zone: classifyZone(decelNeeded),
    };
  }
  return result;
}

export interface RacingLineRibbon {
  /** Flat [x, y, z, x, y, z, ...] vertex positions, left/right pairs per point. */
  positions: Float32Array;
  /** Flat [r, g, b, r, g, b, ...] per-vertex colors, 0-1 range. */
  colors: Float32Array;
  /** Triangle vertex indices. */
  indices: Uint32Array;
}

/**
 * A flat, colored ribbon mesh tracing the racing line - "wide, like an F1
 * game's throttle map" rather than a thin wireframe line. Both vertices at
 * a given point share that point's own zone color, so the color only
 * varies along the line's length, not across its width. Small, fixed
 * width (not the track's own width) - this is an overlay drawn on top of
 * the track surface, not a lane.
 */
export function buildRacingLineRibbon(
  line: RacingLinePoint[],
  halfWidthMeters: number,
  zoneColor: Record<ThrottleZone, [number, number, number]>
): RacingLineRibbon {
  const n = line.length;
  const points = line.map((p) => p.position);
  const positions = new Float32Array(n * 2 * 3);
  const colors = new Float32Array(n * 2 * 3);

  for (let i = 0; i < n; i++) {
    const [x, y, z] = points[i];
    const tangent = unitTangentAt(points, i);
    const rightX = -tangent.z;
    const rightZ = tangent.x;
    const [r, g, b] = zoneColor[line[i].zone];

    const leftIdx = i * 2 * 3;
    const rightIdx = leftIdx + 3;
    positions[leftIdx] = x - rightX * halfWidthMeters;
    positions[leftIdx + 1] = y;
    positions[leftIdx + 2] = z - rightZ * halfWidthMeters;
    positions[rightIdx] = x + rightX * halfWidthMeters;
    positions[rightIdx + 1] = y;
    positions[rightIdx + 2] = z + rightZ * halfWidthMeters;

    colors[leftIdx] = r;
    colors[leftIdx + 1] = g;
    colors[leftIdx + 2] = b;
    colors[rightIdx] = r;
    colors[rightIdx + 1] = g;
    colors[rightIdx + 2] = b;
  }

  const indices = new Uint32Array(n * 6);
  for (let i = 0; i < n; i++) {
    const l0 = i * 2;
    const r0 = l0 + 1;
    const l1 = ((i + 1) % n) * 2;
    const r1 = l1 + 1;
    const o = i * 6;
    indices[o] = l0;
    indices[o + 1] = r0;
    indices[o + 2] = l1;
    indices[o + 3] = r0;
    indices[o + 4] = r1;
    indices[o + 5] = l1;
  }

  return { positions, colors, indices };
}
