import { DEPLOY_BOOST_MULTIPLIER } from "../physics/energy";
import { computeDownforceN } from "../physics/aero";
import { CHASSIS_MASS } from "../physics/vehicle";
import { peakFrictionMu } from "../physics/tireModel";
import { bankedHeight, stationOf } from "./banking";
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
const MAX_OFFSET_FRACTION_OF_HALF_WIDTH = 0.76;
// An inside offset larger than the local corner radius folds the line through
// itself at hairpins. The old fixed 75%-of-half-width cap ignored that
// constraint and produced near-zero-length segments at COTA, Bahrain and
// Melbourne. Keep a safe fraction of the measured centerline radius.
const OFFSET_RADIUS_FRACTION = 0.24;
const OFFSET_RADIUS_GUARD_POINTS = 8;
const OFFSET_MIN_FRACTION_OF_HALF_WIDTH = 0.15;
const SMOOTHING_BOX_RADIUS = 10;
const SMOOTHING_PASSES = 4;
const MIN_PROFILE_SEGMENT_METERS = 0.5;

// Speed-profile constants (also used to color the line - see ThrottleZone
// below). The AI profile is the conservative reference envelope; a separate
// driver-facing profile below keeps the visible cue from warning too early.
// The normal and boosted ceilings leave room above the car's drag-limited
// cruise so deployment can change the speed actually carried down a straight.
//
// The per-corner cap below used to be an empirically-tuned linear penalty
// on a raw cross-product "turn" signal (turn * CURVATURE_SPEED_PENALTY).
// That signal is sin(angle-between-tangents), which is ambiguous past 90
// degrees (sin looks the same for a 20 degree kink and a 160 degree
// hairpin) - real corners sharp enough to matter for AI off-track behavior
// can exceed that over this lookahead. It's replaced with an actual
// curvature estimate (unambiguous turn angle via atan2, divided by the
// real arc length between the lookahead points) and a lateral-grip speed
// cap derived from the tire/aero model itself (see maxLateralAccelMs2):
// v <= sqrt(a_lat(v) * radius), solved by fixed-point iteration since the
// cap depends on speed through downforce. A flat ~1.2g cap was tried first
// and misfit both ends of the lap at once (see LATERAL_SAFETY_FACTOR).
const SPEED_LOOKAHEAD_POINTS = 30;
/**
 * Straight-line reference speed for the shared AI profile. This is above the
 * normal high-downforce equilibrium on purpose: the profile is a target
 * envelope, not a second hard speed clamp, and leaving headroom above the
 * car's drag-limited cruise is what makes a deployment useful on a long
 * straight. The boosted profile gets a separate ceiling below.
 */
export const MAX_SPEED_MS = 86;
export const MAX_BOOST_SPEED_MS = 94;
const MIN_CORNER_SPEED_MS = 12;
// Lateral grip cap, derived from the same physics the car drives on instead
// of a separately-tuned constant: peak tire mu at the speed's own
// aero-loaded normal force (see peakFrictionMu / computeDownforceN),
// times a safety factor. The factor covers what the steady-state number
// doesn't: combined slip (corners are entered under braking, exited under
// power - the friction circle is shared), load transfer unloading the
// inside tires, tire wear through a stint, and the AI's own tracking error
// around the precomputed line. Checked 0.8 against the full 180s AI gate
// on all five circuits (see tests/trackAIStability.test.ts) - the profile
// this produces is one the pure-pursuit driver can actually hold.
//
// Why speed-dependent at all: a flat cap misfits both ends of the lap at
// once. At 60+ m/s the car pulls ~2.5g+ on downforce the flat 1.2g cap
// ignored, so fast sweepers demanded braking the car never needed (red
// line where the corner goes flat). At 12-20 m/s there is little
// downforce and the flat cap was, if anything, generous, so hairpins
// targeted speeds the car couldn't hold and the AI ran wide. One curve
// fixes both directions: ~16 m/s² slow, ~25+ fast.
const LATERAL_SAFETY_FACTOR = 0.8;
// Backward/forward passes enforce a physically-plausible speed profile: you
// can't be doing 250 km/h one point and 65 km/h the next just because a
// tight corner is there - braking (and accelerating) takes distance. Values
// are a plausible constant-deceleration/acceleration approximation for this
// car (roughly 1.4g braking, 0.85g acceleration) for shaping a smooth
// profile, not a physics simulation in their own right.
export const MAX_DECEL_MS2 = 14;
// The AI's 14 m/s^2 cap is intentionally conservative. A clean braking trace
// for the current car reaches roughly 2.1-2.6g; 18 m/s^2 leaves margin for
// reaction and combined slip while moving the driver's brake cue closer to
// the physical braking point. It is display-only and never enters the AI
// control target.
const DRIVER_MAX_DECEL_MS2 = 18;
// The forward profile now allows the car's acceleration-limited exits to
// catch up to the next corner, while retaining enough margin for close
// traffic to settle cleanly. Braking is still governed by the unchanged
// physical backward pass above.
export const MAX_ACCEL_MS2 = 8.5;
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

// The visible line is a driver cue, not the AI's conservative safety target.
// These slightly wider bands keep the first color change closer to the actual
// braking point instead of warning at the earliest mathematical decel bump.
const DISPLAY_LIFT_DECEL_THRESHOLD = 0.6;
const DISPLAY_BRAKE_MEDIUM_DECEL_THRESHOLD = 4;
const DISPLAY_BRAKE_HARD_DECEL_THRESHOLD = 9;

export type ThrottleZone = "throttle" | "lift" | "brake-medium" | "brake-hard";

export interface RacingLinePoint {
  position: [number, number, number];
  /** Physically-plausible target speed at this point, m/s. */
  targetSpeedMs: number;
  /**
   * Same profile, but assuming Push-to-Pass boost (see energy.ts) is being
   * deployed on approach - only ever higher than targetSpeedMs where a
   * boost-eligible straight/corner-exit lets you actually carry more speed,
   * and identical to it wherever a real corner's braking distance (backward
   * pass, unboosted MAX_DECEL_MS2 - brakes aren't boosted) is already the
   * binding constraint. See boostEligible and the module comment on
   * computeCappedSpeedProfile for why this falls out of the same two-pass
   * algorithm for free instead of needing separate lookahead logic.
   */
  boostedTargetSpeedMs: number;
  /**
   * True where deploying boost right now would actually let the car carry
   * more speed than the unboosted profile - i.e. an acceleration-limited
   * stretch (a straight, a corner exit), not a deceleration-limited one
   * (already braking for what's ahead). This is what makes boost deployment
   * closed-loop rather than a naive zone gate: a corner's braking point is
   * governed by the SAME unboosted decel pass in both profiles, so this
   * flag can never stay true into the zone where boosting would actually
   * cause an overspeed problem.
   */
  boostEligible: boolean;
  /** AI-facing classification, retained as the conservative safety envelope. */
  zone: ThrottleZone;
  /**
   * Driver-facing braking target. It uses the measured brake capability rather
   * than the deliberately conservative AI decel cap, so the visible ribbon
   * does not ask the player to brake earlier than the car actually needs.
   * Optional for small synthetic line fixtures in tests and integrations.
   */
  displayTargetSpeedMs?: number;
  /** Driver-facing color band, independent from the AI's `zone`. */
  displayZone?: ThrottleZone;
  /** Arc length from this point to the next (wrapping at the lap), meters. */
  distanceToNextMeters: number;
}

function unitTangentAt(points: readonly (readonly [number, number, number])[], i: number): { x: number; z: number } {
  const n = points.length;
  const p = points[((i - 1) % n + n) % n];
  const q = points[(((i + 1) % n) + n) % n];
  const tx = q[0] - p[0];
  const tz = q[2] - p[2];
  const len = Math.hypot(tx, tz) || 1;
  return { x: tx / len, z: tz / len };
}

/** Local centerline radius from a short, stable tangent window. */
function centerlineRadiusAt(
  points: readonly (readonly [number, number, number])[],
  index: number
): number {
  const n = points.length;
  const halfWindow = 3;
  const a = unitTangentAt(points, index - halfWindow);
  const b = unitTangentAt(points, index + halfWindow);
  const angle = Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z));
  if (angle < 1e-5) return Infinity;
  let arcLength = 0;
  for (let k = -halfWindow; k < halfWindow; k++) {
    const p = points[(index + k + n) % n];
    const q = points[(index + k + 1 + n) % n];
    arcLength += Math.hypot(q[0] - p[0], q[2] - p[2]);
  }
  return arcLength / angle;
}

/**
 * The backward (braking-distance) then forward (accel-distance) squeeze
 * that turns a raw per-point speed cap into a physically-reachable profile.
 * Backward runs to completion first (using the real, unboosted decelMs2 -
 * brakes aren't boosted), THEN forward runs against that already-capped
 * array - so raising accelMs2 for a "boosted" call can only ever raise
 * values in acceleration-limited regions (straights, corner exits): a
 * decel-limited value already fixed by the backward pass is a `Math.min`
 * ceiling the forward pass can lower further but never lift back up. This
 * is the mechanism that makes a boosted profile automatically respect real
 * braking distance into the next corner without any separate lookahead
 * calculation - see boostEligible on RacingLinePoint.
 */
function computeCappedSpeedProfile(
  rawSpeedCap: Float64Array,
  segmentLengths: Float64Array,
  accelMs2: number,
  decelMs2: number
): Float64Array {
  const n = rawSpeedCap.length;
  const speed = Float64Array.from(rawSpeedCap);
  for (let lap = 0; lap < SPEED_PASS_LAPS; lap++) {
    for (let k = 0; k < n; k++) {
      const i = (n - 1 - k + n) % n;
      const next = (i + 1) % n;
      const maxReachable = Math.sqrt(speed[next] ** 2 + 2 * decelMs2 * segmentLengths[i]);
      speed[i] = Math.min(speed[i], maxReachable);
    }
  }
  for (let lap = 0; lap < SPEED_PASS_LAPS; lap++) {
    for (let i = 0; i < n; i++) {
      const prev = (i - 1 + n) % n;
      const maxReachable = Math.sqrt(speed[prev] ** 2 + 2 * accelMs2 * segmentLengths[prev]);
      speed[i] = Math.min(speed[i], maxReachable);
    }
  }
  return speed;
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

export function classifyZone(decelMs2: number): ThrottleZone {
  if (decelMs2 <= LIFT_DECEL_THRESHOLD) return "throttle";
  if (decelMs2 <= BRAKE_MEDIUM_DECEL_THRESHOLD) return "lift";
  if (decelMs2 <= BRAKE_HARD_DECEL_THRESHOLD) return "brake-medium";
  return "brake-hard";
}

function classifyDisplayZone(decelMs2: number): ThrottleZone {
  if (decelMs2 <= DISPLAY_LIFT_DECEL_THRESHOLD) return "throttle";
  if (decelMs2 <= DISPLAY_BRAKE_MEDIUM_DECEL_THRESHOLD) return "lift";
  if (decelMs2 <= DISPLAY_BRAKE_HARD_DECEL_THRESHOLD) return "brake-medium";
  return "brake-hard";
}

/**
 * Peak lateral acceleration the car can sustain at a given speed, from the
 * tire model's own load-sensitive mu at that speed's aero load - see the
 * LATERAL_SAFETY_FACTOR comment for what the factor covers.
 */
export function maxLateralAccelMs2(speedMs: number): number {
  const downforceN = computeDownforceN(Math.max(0, speedMs));
  const loadPerTireN = (CHASSIS_MASS * 9.81 + downforceN) / 4;
  const mu = peakFrictionMu(loadPerTireN);
  return LATERAL_SAFETY_FACTOR * mu * (9.81 + downforceN / CHASSIS_MASS);
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
  const offsetLimits = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const behind = unitTangentAt(centerline, (i - CURVATURE_LOOKAHEAD_POINTS + n) % n);
    const ahead = unitTangentAt(centerline, (i + CURVATURE_LOOKAHEAD_POINTS) % n);
    const turn = behind.x * ahead.z - behind.z * ahead.x;
    const tangent = unitTangentAt(centerline, i);
    rightVectors[i] = { x: -tangent.z, z: tangent.x };
    const halfWidth = track.width[i] / 2;
    let radiusLimit = Infinity;
    for (let guard = -OFFSET_RADIUS_GUARD_POINTS; guard <= OFFSET_RADIUS_GUARD_POINTS; guard++) {
      radiusLimit = Math.min(radiusLimit, centerlineRadiusAt(centerline, i + guard));
    }
    radiusLimit *= OFFSET_RADIUS_FRACTION;
    // Suzuka keeps its previously validated broad offset through the bridge
    // transition; the radius guard is for the other circuits' isolated
    // hairpin spikes, not for the crossover's load-sensitive geometry.
    const maxOffset = track.id === "suzuka"
      ? halfWidth * MAX_OFFSET_FRACTION_OF_HALF_WIDTH
      : Math.min(
          halfWidth * MAX_OFFSET_FRACTION_OF_HALF_WIDTH,
          Math.max(halfWidth * OFFSET_MIN_FRACTION_OF_HALF_WIDTH, radiusLimit)
        );
    offsetLimits[i] = maxOffset;
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
    const maxOffset = offsetLimits[i];
    offsets[i] = Math.max(-maxOffset, Math.min(maxOffset, offsets[i]));
  }

  const positions: [number, number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = centerline[i];
    const r = rightVectors[i];
    // Ride the banked surface (see lib/tracks/banking.ts), not the
    // centerline plane - the overlay ribbon below is only 0.6m each side,
    // but 19 degrees of cross-slope still buries its high edge ~0.2m
    // without this. AI-side consumers only read x/z (see pathFollower's
    // own destructure), so the y change is visual-only.
    positions[i] = [
      x + r.x * offsets[i],
      bankedHeight(
        track.id,
        stationOf(i, n, track.lengthMeters),
        track.lengthMeters,
        y,
        offsets[i]
      ),
      z + r.z * offsets[i],
    ];
  }

  // Repair sub-meter duplicate samples in the closed path before measuring
  // curvature. Several source polylines contain a duplicated point at a
  // hairpin or start/finish splice; leaving two line vertices on top of each
  // other creates a fake 90-degree kink and an unnecessary 12 m/s target.
  // The midpoint remains inside the same track corridor and keeps the public
  // one-point-per-centerline-index contract intact.
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    if (Math.hypot(positions[next][0] - positions[i][0], positions[next][2] - positions[i][2]) >= MIN_PROFILE_SEGMENT_METERS) {
      continue;
    }
    const previous = positions[(i - 1 + n) % n];
    const following = positions[next];
    positions[i] = [
      (previous[0] + following[0]) / 2,
      (previous[1] + following[1]) / 2,
      (previous[2] + following[2]) / 2,
    ];
  }

  const segmentLengths = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = positions[i];
    const b = positions[(i + 1) % n];
    // A resampled centerline can contain a near-duplicate pair at a splice or
    // start/finish seam. Keep a finite physical floor in the profile so one
    // sub-meter artifact cannot create a false hairpin and a 12 m/s target.
    segmentLengths[i] = Math.max(
      MIN_PROFILE_SEGMENT_METERS,
      Math.hypot(b[0] - a[0], b[2] - a[2])
    );
  }

  // Curvature is measured on a lightly smoothed copy of the rendered line.
  // The copy is only for sensing; AI and the visible ribbon still use the
  // original positions, while the filter rejects single-point GPS/spline
  // spikes without hiding a real corner several samples wide.
  const curvaturePositions: [number, number, number][] = track.id === "suzuka" ? positions : positions.map((point, i) => {
    const previous = positions[(i - 1 + n) % n];
    const next = positions[(i + 1) % n];
    return [
      (previous[0] + point[0] * 2 + next[0]) / 4,
      (previous[1] + point[1] * 2 + next[1]) / 4,
      (previous[2] + point[2] * 2 + next[2]) / 4,
    ];
  });

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
  //
  // Curvature is measured as the MAXIMUM over six 10-point sub-windows
  // spanning the same +-30-point reach, never the net turn over the whole
  // reach. A net turn cancels through direction changes: esses, chicanes
  // and the approach/exit of hairpins read near-zero over 60m and the old
  // net measurement targeted full speed through them (measured: the AI
  // sailing 100m+ off at Becketts, and 45 m/s targeted at Monaco's
  // hairpin). Each 10m sub-window is long enough that centerline noise
  // never binds (noise reads as radius 300m+, capped by MAX_SPEED_MS long
  // before it matters) yet short enough to catch each direction change of
  // an esses on its own.
  const CURVATURE_SUB_WINDOWS = 6;
  const CURVATURE_SUB_POINTS = 10;
  const curveOnlySpeed = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let curvature = 0;
    for (let w = 0; w < CURVATURE_SUB_WINDOWS; w++) {
      const a = (i - SPEED_LOOKAHEAD_POINTS + w * CURVATURE_SUB_POINTS + n) % n;
      const b = (i - SPEED_LOOKAHEAD_POINTS + (w + 1) * CURVATURE_SUB_POINTS + n) % n;
      const behind = unitTangentAt(curvaturePositions, a);
      const ahead = unitTangentAt(curvaturePositions, b);
      const cross = behind.x * ahead.z - behind.z * ahead.x;
      const dot = behind.x * ahead.x + behind.z * ahead.z;
      const turnAngle = Math.abs(Math.atan2(cross, dot));
      let arcLength = 0;
      for (let k = 0; k < CURVATURE_SUB_POINTS; k++) {
        arcLength += segmentLengths[(a + k) % n];
      }
      if (arcLength > 1e-6) curvature = Math.max(curvature, turnAngle / arcLength);
    }
    // v = sqrt(a(v) * r) is implicit (the cap itself depends on speed via
    // downforce), so iterate a few times from the old flat-cap answer - the
    // map is a contraction (sqrt of an affine function), so this converges
    // to the fixed point within a fraction of an m/s.
    let capped = MAX_SPEED_MS;
    if (curvature > 1e-9) {
      const radius = 1 / curvature;
      capped = Math.sqrt(12 / curvature);
      for (let k = 0; k < 4; k++) {
        capped = Math.sqrt(maxLateralAccelMs2(capped) * radius);
      }
    }
    curveOnlySpeed[i] = Math.min(MAX_SPEED_MS, Math.max(MIN_CORNER_SPEED_MS, capped));
  }

  // Suzuka's bridge transitions change the contact patch's load and yaw
  // response abruptly. Keep its profile at the previously validated
  // acceleration ceiling even while the other circuits use the more realistic
  // exit acceleration above; the live and headless AI must not approach that
  // crossover deck with a freshly raised corner-exit target.
  const profileAccelMs2 = track.id === "suzuka" ? 8 : MAX_ACCEL_MS2;
  const targetSpeedMs = computeCappedSpeedProfile(curveOnlySpeed, segmentLengths, profileAccelMs2, MAX_DECEL_MS2);

  // Keep the safety-tuned profile above for AI stability, but derive a second
  // profile for the driver-facing ribbon. The higher braking capability moves
  // the colored braking band toward the real point where the player actually
  // needs to brake, without changing any AI target or control decision.
  const driverTargetSpeedMs = computeCappedSpeedProfile(
    curveOnlySpeed,
    segmentLengths,
    profileAccelMs2,
    DRIVER_MAX_DECEL_MS2
  );

  // Same corner caps and the same real (unboosted) decel limit - only the
  // forward/accel side and the straight-line ceiling are boosted, matching
  // how Push-to-Pass actually works (more engine force, not better brakes).
  // A separate raw ceiling is important: without it, deployment could only
  // help while the car was still below the normal profile's artificial top
  // speed, which is exactly the straight-line case the player cares about.
  const boostedCurveOnlySpeed = Float64Array.from(curveOnlySpeed, (speed) =>
    Math.min(MAX_BOOST_SPEED_MS, speed)
  );
  const boostedTargetSpeedMs = computeCappedSpeedProfile(
    boostedCurveOnlySpeed,
    segmentLengths,
    profileAccelMs2 * DEPLOY_BOOST_MULTIPLIER,
    MAX_DECEL_MS2
  );

  // Keep the original AI-facing classification signal exactly as it was
  // before the driver profile was added. This is deliberately separate from
  // displaySpeedMs: zone feeds pathFollower/racecraft, so changing it here
  // would silently change AI braking and re-open old stability failures.
  let aiZoneSpeedMs: Float64Array = Float64Array.from(targetSpeedMs);
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    aiZoneSpeedMs = boxFilterPass(aiZoneSpeedMs, SMOOTHING_BOX_RADIUS);
  }

  // Display-only smoothed copy of the driver profile, used only to classify
  // the visible ribbon. It is never returned as the AI-facing targetSpeedMs.
  let displaySpeedMs: Float64Array = Float64Array.from(driverTargetSpeedMs);
  for (let pass = 0; pass < SMOOTHING_PASSES; pass++) {
    displaySpeedMs = boxFilterPass(displaySpeedMs, SMOOTHING_BOX_RADIUS);
  }

  const result: RacingLinePoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    const decelNeeded = Math.max(
      0,
      (aiZoneSpeedMs[i] ** 2 - aiZoneSpeedMs[next] ** 2) / (2 * segmentLengths[i])
    );
    const zone = classifyZone(decelNeeded);
    const displayDecelNeeded = Math.max(
      0,
      (displaySpeedMs[i] ** 2 - displaySpeedMs[next] ** 2) / (2 * segmentLengths[i])
    );
    const displayZone = classifyDisplayZone(displayDecelNeeded);
    result[i] = {
      position: positions[i],
      targetSpeedMs: targetSpeedMs[i],
      boostedTargetSpeedMs: boostedTargetSpeedMs[i],
      // Epsilon guards against the two independent pass computations
      // disagreeing by float noise even where they're conceptually meant
      // to be identical (both decel-limited by the same backward pass).
      // Plus the AI zone gate: the zone comes from the SMOOTHED AI profile
      // while eligibility compares raw profiles, so at a braking zone's
      // smeared edge a point can read brake-hard while the raw comparison
      // still favors boost (corner exit overlapping the next corner's
      // anticipation). The braking point itself still survives boosting
      // (shared backward pass), but telling the driver to deploy where the
      // line burns red is wrong advice - never eligible under red.
      boostEligible: boostedTargetSpeedMs[i] > targetSpeedMs[i] + 0.05 && zone !== "brake-hard",
      zone,
      displayTargetSpeedMs: driverTargetSpeedMs[i],
      displayZone,
      distanceToNextMeters: segmentLengths[i],
    };
  }
  return result;
}

// A separate, tiny copy of the same brute-force nearest-point scan
// pathFollower.ts uses for the AI's own steering - kept independent rather
// than shared so this purely cosmetic HUD feature (the live racing-line
// color below) can never risk a diff touching the AI control file. This
// project's own history (see racingLine.ts's module comment on
// displaySpeedMs) is that even innocuous-looking changes near the AI's
// control path have caused real regressions.
//
// The optional warm start mirrors pathFollower's version with the same
// validated-window shape (±40 points, 30m acceptance bound falling back
// to the exact scan) but lives here, in this file, per the isolation
// policy above: the HUD's per-frame scan drops from O(n) to O(window)
// without the two files sharing any code.
function nearestPointIndex(
  line: RacingLinePoint[],
  x: number,
  z: number,
  warmStartIndex?: number
): number {
  if (warmStartIndex !== undefined && line.length > 0) {
    const n = line.length;
    let bestIdx = -1;
    let bestDistSq = Infinity;
    for (let k = -40; k <= 40; k++) {
      const i = (warmStartIndex + k + n) % n;
      const [lx, , lz] = line[i].position;
      const distSq = (lx - x) ** 2 + (lz - z) ** 2;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestDistSq <= 30 * 30) return bestIdx;
  }
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < line.length; i++) {
    const [lx, , lz] = line[i].position;
    const distSq = (lx - x) ** 2 + (lz - z) ** 2;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

// Live-overlay shaping (see updateLiveZoneColors): the static profile owns
// the color of the road ahead; current speed is allowed to escalate only in
// a short reaction window around the car. Using the current speed to recolor
// all 150m made a fast car paint the whole visible straight red even when the
// line was not actually a braking zone. A red line now means the baked profile
// says brake, or the car is already so far over the local target that braking
// is required immediately.
const LIVE_REACTION_DISTANCE_METERS = 10;
const LIVE_OVERSPEED_WINDOW_METERS = 35;
const LIVE_SPEED_TOLERANCE_FRACTION = 0.05;
const ZONE_SEVERITY: Record<ThrottleZone, number> = {
  throttle: 0,
  lift: 1,
  "brake-medium": 2,
  "brake-hard": 3,
};

function mostSevereZone(a: ThrottleZone, b: ThrottleZone): ThrottleZone {
  return ZONE_SEVERITY[a] >= ZONE_SEVERITY[b] ? a : b;
}

/**
 * Recolors the racing line ribbon's vertex colors in place for a stretch
 * ahead of the car's actual current position. The baked per-point `zone`
 * is the primary instruction: green means the profile is throttle, while
 * yellow/orange/red mark its actual braking approach. Only the short
 * reaction window around the car compares current speed with the local
 * target, so a fast car cannot turn the entire visible horizon red just by
 * being above the profile.
 *
 * Only repaints `lookaheadMeters` ahead of the car each call - points
 * behind the car, or not yet reached, keep whatever color they last had
 * (the initial static classification, or a stale live snapshot from the
 * last time the car passed nearby). Both are outside the driver's forward
 * view in practice, so resetting a trailing window every frame wasn't
 * judged worth the extra bookkeeping.
 */
export function updateLiveZoneColors(
  line: RacingLinePoint[],
  colors: Float32Array,
  carX: number,
  carZ: number,
  currentSpeedMs: number,
  lookaheadMeters: number,
  zoneColor: Record<ThrottleZone, [number, number, number]>,
  warmStartIndex?: number
): number {
  const n = line.length;
  const nearest = nearestPointIndex(line, carX, carZ, warmStartIndex);
  let distance = 0;
  for (let k = 0; k < n; k++) {
    const i = (nearest + k) % n;
    const d = Math.max(distance, LIVE_REACTION_DISTANCE_METERS);
    // Use the driver-facing baked zone for the road ahead. Only the first
    // short reaction window is allowed to escalate it when the car is
    // genuinely carrying too much speed right now; the old all-distance
    // calculation repainted a fast straight red from end to end.
    let zone = line[i].displayZone ?? line[i].zone;
    if (distance <= LIVE_OVERSPEED_WINDOW_METERS) {
      const driverTarget = line[i].displayTargetSpeedMs ?? line[i].targetSpeedMs;
      const toleratedTarget = driverTarget * (1 + LIVE_SPEED_TOLERANCE_FRACTION);
      const decelNeeded = Math.max(0, (currentSpeedMs ** 2 - toleratedTarget ** 2) / (2 * d));
      zone = mostSevereZone(zone, classifyDisplayZone(decelNeeded));
    }
    const [r, g, b] = zoneColor[zone];
    const idx = i * 6;
    colors[idx] = r;
    colors[idx + 1] = g;
    colors[idx + 2] = b;
    colors[idx + 3] = r;
    colors[idx + 4] = g;
    colors[idx + 5] = b;
    distance += line[i].distanceToNextMeters;
    if (distance > lookaheadMeters) break;
  }
  // Hand the anchor to the next frame: a moving car's nearest point moves
  // a point or two per frame, so the next call's warm-started windowed
  // search is equivalent to the full scan at a fraction of the cost.
  return nearest;
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
 * a given point share that point's own driver-facing zone color, so the color
 * only varies along the line's length, not across its width. Small, fixed
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
    const [r, g, b] = zoneColor[line[i].displayZone ?? line[i].zone];

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
