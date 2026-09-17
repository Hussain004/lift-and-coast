import type { TrackData } from "./types";
import {
  checkTrackLimits,
  computeSurfaceGripMultiplier,
  type TrackLimitStatus,
} from "./trackLimits";

// Plan section 4 point 7 (surface zones) and section 5 depth feature 6
// (kerb & surface interaction). This project has no authored per-corner kerb
// or runoff data and no public dataset for one either - kerb placement is a
// real circuit's own design decision, not something a centerline implies -
// so everything here is *derived* from the centerline's own curvature, the
// same way the racing line is (see racingLine.ts). It is deliberately a
// coarse approximation: enough for kerbs to be a real skill element (use
// them, but they unsettle the car) and for gravel to grab a wide exit,
// without pretending to know where a real circuit put its armco.
//
// The one thing it derives that is not guesswork is *where* a surface
// changes: kerbs and runoff are per-centerline-point zones in the track's
// own frame, exactly like width, so a car straddling the edge is classified
// by its real lateral offset rather than by any new geometry.
//
// This module is pure data + arithmetic. The physics wiring lives in the
// callers (Car.tsx, AICar.tsx, lib/ai/harness.ts) and the visual kerb strips
// in lib/tracks/mesh.ts (buildKerbGeometry).

/** What a wheel is standing on. */
export type SurfaceKind = "asphalt" | "kerb" | "grass" | "gravel";

/**
 * Plan section 4 point 6's three kerb types. Real circuits pick per corner:
 * a flat painted kerb for a fast sweeper, a raised one where drivers would
 * cut, and a sausage kerb at the apex of the tightest corners. Severity is
 * derived from the corner's own tightest radius (see tighterKerbType).
 */
export type KerbType = "low" | "aggressive" | "sausage";

/**
 * The derived zones, one entry per centerline index. A side is null when
 * there is no kerb there, which is the case on every straight and through
 * the middle of a long constant-radius sweeper's outside.
 */
export interface SurfaceZone {
  left: KerbType | null;
  right: KerbType | null;
  /** Gravel runoff band beyond the kerb on that side, if any. */
  gravelLeft: boolean;
  gravelRight: boolean;
}

export interface SurfaceSample {
  surface: SurfaceKind;
  /** Which kerb the wheel is on, when surface === "kerb". */
  kerbType: KerbType | null;
  /** 0 on the ribbon, positive past the ribbon edge (m) - see checkTrackLimits. */
  distanceFromEdgeMeters: number;
  /** Signed lateral offset from the centerline, + = right (m). */
  lateralMeters: number;
  /** Multiplies wheel grip (<= 1, same one-way-shrink contract as the rest). */
  gripMultiplier: number;
  /**
   * Extra speed-proportional drag on this surface, N per (m/s). 0 on asphalt
   * and kerbs; small on grass; large on gravel, which is what makes a trap
   * "grab and bog" the car instead of merely costing grip.
   */
  dragCoefficient: number;
  /**
   * How far the surface under this wheel is raised above the ribbon, in
   * meters. Applied by the callers through the wheel's suspension rest
   * length rather than as a collider step - see KERB_HEIGHT_METERS.
   */
  kerbRiseMeters: number;
}

// ---------------------------------------------------------------------------
// Curvature
// ---------------------------------------------------------------------------

// The corner classifier integrates the turn over a window either side of each
// point (summing many small tangent-to-tangent angles) instead of taking one
// atan2 across the whole window. The single-jump form wraps past 180 degrees,
// which reads a 15m hairpin as a 80m corner - fine for a speed cap, useless
// for deciding where the tightest kerbs go. Summing small steps cannot wrap,
// and noise in the individual angles mostly cancels.
//
// Several window lengths, tightest wins, because a hairpin at the end of a
// long sweeper must still read as a hairpin: short windows resolve the apex,
// long ones keep a gentle constant-radius corner from looking like a straight
// (the built centerline is 2m apart, so 6/10/16 points are 12/20/32m radii of
// investigation).
const CURVATURE_WINDOWS = [6, 10, 16];
// Box-filter passes over the curvature signal before thresholding. The raw
// signal is differentiable noise at the 2m centerline spacing; this is the
// same fix (and the same reasoning) as racingLine.ts's offset smoothing.
const CURVATURE_SMOOTH_RADIUS = 6;
const CURVATURE_SMOOTH_PASSES = 2;

// Thresholds are radii, in meters, because that is how a circuit is
// described. 250m: any real corner (and no straight - a straight's radius is
// effectively infinite, and the smoothed noise floor on the real data sits an
// order of magnitude below this). 120m: the tighter corners, where a wide
// exit is worth a gravel trap. Calibrated against the real data rather than
// guessed: raising either radius mostly *lengthens* the zones (the number of
// separate kerb runs barely moves - Silverstone stays 19, Monza 12, Spa 23,
// Suzuka 19 across 200-800m, close to those circuits' real corner counts),
// so these values are about how much of each corner's edge counts, not about
// which corners exist at all.
const KERB_MAX_RADIUS_METERS = 250;
const GRAVEL_MAX_RADIUS_METERS = 120;
// Separate hysteresis floors so a corner edge that hovers either side of a
// threshold does not pulse on and off point to point.
const KERB_MAX_RADIUS_HYSTERESIS = 320;
const GRAVEL_MAX_RADIUS_HYSTERESIS = 150;
// Drop any zone shorter than this (and merge any gap shorter than it), in
// points. 10 points is 20m at the built spacing: shorter than the shortest
// real kerb run, longer than the classifier's own noise.
const MIN_ZONE_RUN_POINTS = 10;

// ---------------------------------------------------------------------------
// Geometry of the zones themselves
// ---------------------------------------------------------------------------

/** Kerb strip width beyond the ribbon edge (real kerbs are ~1-1.2m). */
export const KERB_WIDTH_METERS = 1.2;
/**
 * Gravel band width beyond the kerb. A trap has to be wide enough to stop a
 * car that arrives at speed, but not so wide that it swallows the whole run
 * to the next barrier - and it is capped by the 12.5m terrain cells anyway,
 * so beyond this the surface is grass whatever the classifier says.
 */
export const GRAVEL_WIDTH_METERS = 14;
// The rise ramps in over the first 0.5m of the kerb rather than switching on
// at the edge. A hard step is exactly the discontinuity that a 5cm gap
// between the ribbon and the grass caused once already (see mesh.ts's
// GRASS_BELOW_TRACK_METERS) - a sharp pitch spike reported by a real player.
// Ramping it over 0.5m keeps the "thump" while making it a rate-limited one.
const KERB_RAMP_METERS = 0.5;

// Kerb ride heights, in meters. Real numbers: a flat painted kerb is ~3cm, a
// raised "aggressive" one ~5cm, a sausage can be 10-15cm - but this project's
// front suspension only has 0.5m total travel and its documented failure mode
// (AI flip, see memory [[lift_and_coast_ai_flip_nose_scrape]]) is the front
// pinning at that limit, so the sausage tops out at 8cm rather than reality's
// 15. The same numbers are what buildKerbGeometry raises the visible strip by
// (see lib/tracks/mesh.ts), so the car rides on what the driver can see.
const KERB_HEIGHT_METERS: Record<KerbType, number> = {
  low: 0.03,
  aggressive: 0.05,
  sausage: 0.08,
};

/** Kerb ride height for a type, in meters - shared with the visible strips. */
export function kerbHeightMeters(type: KerbType): number {
  return KERB_HEIGHT_METERS[type];
}
// Kerbs are painted and often damp, so they give up a little grip - but far
// less than grass, and a kerb should be worth using. The upset from the rise
// above is the real penalty.
const KERB_GRIP: Record<KerbType, number> = {
  low: 0.96,
  aggressive: 0.9,
  sausage: 0.8,
};

// Gravel: no grip at all and heavy speed-proportional drag. At 30 m/s the
// drag alone is ~1350N, about the car's own engine force, so a trap makes you
// a passenger rather than merely slow - which is what "grab and bog" means.
const GRAVEL_GRIP = 0.3;
const GRAVEL_DRAG_N_PER_MS = 45;
// Grass keeps the shape of the grip falloff this project already had (see
// computeSurfaceGripMultiplier), but its floor was raised to 0.6 as part of
// this feature's planned revisit ("revisit with real per-zone grip/drag once
// the track pipeline authors them"): ridden per-wheel now instead of by the
// chassis center, a 0.35 floor let a wide exit on a fast no-kerb sweeper
// (Suzuka's 130R reads as a straight here, so there is no kerb to buffer it)
// snowball into an unrecoverable full-throttle slide - the per-track AI gate
// measured it. The falloff is still real (especially for a single wheel
// crossing), and a light drag so running wide costs time as well as grip.
// Deliberately far above gravel: a wide exit stays drivable, gravel is the
// trap.
const GRASS_DRAG_N_PER_MS = 8;

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

function unitTangentAt(
  points: readonly (readonly [number, number, number])[],
  i: number
): { x: number; z: number } {
  const n = points.length;
  const p = points[(i - 1 + n) % n];
  const q = points[(i + 1) % n];
  const tx = q[0] - p[0];
  const tz = q[2] - p[2];
  const len = Math.hypot(tx, tz) || 1;
  return { x: tx / len, z: tz / len };
}

/**
 * Tightest curvature estimate at index i, in 1/m: the largest over the
 * windows, each computed as total signed turn / total arc length. Signed, so
 * the caller can tell which way the corner goes (and therefore which side is
 * the apex); the sign follows the same convention as racingLine.ts's turn
 * signal - positive is a right-hand corner.
 */
function signedCurvatureAt(
  points: readonly (readonly [number, number, number])[],
  i: number,
  segmentLengths: Float64Array
): number {
  const n = points.length;
  let tightest = 0;
  let tightestMagnitude = 0;
  for (const window of CURVATURE_WINDOWS) {
    let turn = 0;
    let arc = 0;
    for (let k = -window; k < window; k++) {
      const a = unitTangentAt(points, (i + k + n) % n);
      const b = unitTangentAt(points, (i + k + 1 + n) % n);
      turn += Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z);
      arc += segmentLengths[(i + k + n) % n];
    }
    if (arc < 1e-6) continue;
    const curvature = turn / arc;
    // Tightest wins, not the average: a hairpin at the end of a long sweeper
    // must still read as a hairpin.
    if (Math.abs(curvature) > tightestMagnitude) {
      tightestMagnitude = Math.abs(curvature);
      tightest = curvature;
    }
  }
  return tightest;
}

function boxFilter(values: Float64Array, radius: number): Float64Array {
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

/**
 * Boolean-per-point cleanup with hysteresis plus a minimum run length:
 * a zone starts where the signal crosses the tight threshold, only ends once
 * it is looser than the loose one, and any resulting run shorter than
 * MIN_ZONE_RUN_POINTS is discarded (a lone point over the line is noise).
 *
 * The scan works on a linear view, so a run that wraps around index 0
 * (index 0 is mid-run) is first rotated to start at a run boundary - or, if
 * the whole ring is one run (a constant-radius circuit), kept whole; without
 * that guard a fully-active ring reads as "everything is the wrap-around
 * prefix" and is zeroed entirely.
 */
function thresholdRuns(
  signal: Float64Array,
  tightThreshold: number,
  looseThreshold: number
): boolean[] {
  const n = signal.length;
  const hysteresis = new Array<boolean>(n).fill(false);
  let inRun = false;
  for (let i = 0; i < n; i++) {
    const value = signal[i];
    if (!inRun && value >= tightThreshold) inRun = true;
    else if (inRun && value < looseThreshold) inRun = false;
    hysteresis[i] = inRun;
  }

  // Rotate so the linear scan below starts at a run boundary. A fully-active
  // ring is one run and must stay that way (nothing to resolve).
  let rotated = hysteresis;
  let offset = 0;
  if (hysteresis[0] && hysteresis[n - 1]) {
    if (hysteresis.every(Boolean)) return hysteresis;
    let start = 0;
    while (hysteresis[start]) start++;
    offset = start;
    rotated = hysteresis.slice(start).concat(hysteresis.slice(0, start));
  }

  const filtered = rotated.slice();
  let i = 0;
  while (i < n) {
    if (!filtered[i]) {
      i++;
      continue;
    }
    let end = i;
    while (end < n && filtered[end]) end++;
    if (end - i < MIN_ZONE_RUN_POINTS) {
      for (let k = i; k < end; k++) filtered[k] = false;
    }
    i = end;
  }

  const result = new Array<boolean>(n).fill(false);
  for (let k = 0; k < n; k++) {
    if (filtered[k]) result[(k + offset) % n] = true;
  }
  return result;
}

function tighterKerbType(curvature: number): KerbType {
  const radius = 1 / Math.max(curvature, 1e-9);
  // Real kerb-type thresholds, not a percentile: a sausage kerb exists to
  // stop a driver cutting an apex, which only pays at a genuine hairpin or
  // near-hairpin (Monaco's Grand Hotel is ~9m, Budapest's turn 1 ~20m), so
  // it is deliberately rare. A raised "aggressive" kerb covers the tight end
  // of the normal corner range; everything else is the flat painted strip
  // every other corner gets.
  if (radius <= 45) return "sausage";
  if (radius <= 130) return "aggressive";
  return "low";
}

/**
 * One step flatter than the given type - what the *outside* kerb of a corner
 * gets. Real circuits put the aggressive kerb at the apex (where it stops
 * corner cutting) and a flatter one on the exit, and this keeps the two ends
 * of the same corner from reading identically.
 */
function flatter(type: KerbType): KerbType {
  if (type === "sausage") return "aggressive";
  if (type === "aggressive") return "low";
  return "low";
}

const zoneCache = new WeakMap<TrackData, SurfaceZone[]>();

/**
 * Builds (once per track object) the derived kerb and gravel zones, one entry
 * per centerline point. Cached because the game, the AI and the headless
 * harness all ask, and a harness run builds a physics world per scenario.
 */
export function surfaceZones(track: TrackData): SurfaceZone[] {
  const cached = zoneCache.get(track);
  if (cached) return cached;

  const count = track.centerline.length;
  const segmentLengths = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const a = track.centerline[i];
    const b = track.centerline[(i + 1) % count];
    segmentLengths[i] = Math.hypot(b[0] - a[0], b[2] - a[2]);
  }

  const curvature: Float64Array = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    curvature[i] = signedCurvatureAt(track.centerline, i, segmentLengths);
  }
  // Threshold on the magnitude, but keep the sign for the apex side - so
  // smooth a signed copy, which cannot flip a corner's direction.
  let signedSmooth: Float64Array = Float64Array.from(curvature);
  for (let pass = 0; pass < CURVATURE_SMOOTH_PASSES; pass++) {
    signedSmooth = boxFilter(signedSmooth, CURVATURE_SMOOTH_RADIUS);
  }
  const magnitude = new Float64Array(count);
  for (let i = 0; i < count; i++) magnitude[i] = Math.abs(signedSmooth[i]);

  const kerbActive = thresholdRuns(
    magnitude,
    1 / KERB_MAX_RADIUS_METERS,
    1 / KERB_MAX_RADIUS_HYSTERESIS
  );
  const gravelActive = thresholdRuns(
    magnitude,
    1 / GRAVEL_MAX_RADIUS_METERS,
    1 / GRAVEL_MAX_RADIUS_HYSTERESIS
  );

  const zones: SurfaceZone[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const turn = signedSmooth[i];
    const inside = turn > 0 ? "right" : "left";
    const outside = turn > 0 ? "left" : "right";
    const kerb: KerbType | null = kerbActive[i] ? tighterKerbType(magnitude[i]) : null;
    zones[i] = {
      // The apex kerb is the severity the corner earns; the exit kerb one
      // step flatter.
      left: kerb ? (inside === "left" ? kerb : flatter(kerb)) : null,
      right: kerb ? (inside === "right" ? kerb : flatter(kerb)) : null,
      // Gravel only ever on the outside, where a wide exit actually ends up.
      gravelLeft: gravelActive[i] && outside === "left",
      gravelRight: gravelActive[i] && outside === "right",
    };
  }

  zoneCache.set(track, zones);
  return zones;
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Classifies a single point (typically one wheel's ground position) against
 * the derived zones. Does its own nearest-centerline-point scan, so callers
 * that need the limits status too (the reset guard, the lap timer) are doing
 * a little duplicated work - the same trade checkTrackLimits's own comment
 * makes for a single car, and deliberately not shared here because the AI's
 * control path only ever reads its own scan.
 */
export function sampleSurface(track: TrackData, x: number, z: number): SurfaceSample {
  const status = checkTrackLimits(track, x, z);
  return classifySurface(track, status);
}

/**
 * The classification half of sampleSurface, for callers that already have a
 * TrackLimitStatus in hand (and so already paid for the scan).
 */
export function classifySurface(track: TrackData, status: TrackLimitStatus): SurfaceSample {
  const zone = surfaceZones(track)[status.nearestIndex];
  const past = status.distanceFromEdgeMeters;
  const onRight = status.lateralMeters >= 0;
  const kerb = onRight ? zone.right : zone.left;
  const gravel = onRight ? zone.gravelRight : zone.gravelLeft;

  const base = {
    distanceFromEdgeMeters: past,
    lateralMeters: status.lateralMeters,
  };

  if (past <= 0) {
    return {
      ...base,
      surface: "asphalt",
      kerbType: null,
      gripMultiplier: 1,
      dragCoefficient: 0,
      kerbRiseMeters: 0,
    };
  }

  if (kerb && past <= KERB_WIDTH_METERS) {
    const ramp = Math.min(1, past / KERB_RAMP_METERS);
    return {
      ...base,
      surface: "kerb",
      kerbType: kerb,
      gripMultiplier: KERB_GRIP[kerb],
      dragCoefficient: 0,
      kerbRiseMeters: KERB_HEIGHT_METERS[kerb] * ramp,
    };
  }

  if (gravel && past <= KERB_WIDTH_METERS + GRAVEL_WIDTH_METERS) {
    return {
      ...base,
      surface: "gravel",
      kerbType: null,
      gripMultiplier: GRAVEL_GRIP,
      dragCoefficient: GRAVEL_DRAG_N_PER_MS,
      kerbRiseMeters: 0,
    };
  }

  // Grass keeps the original edge falloff (same function, see the floor
  // note above), measured from the ribbon edge - which also means a wheel
  // just past a kerb's outer edge sees the same grip there as it would with
  // no kerb at all, so the two surfaces meet without a step.
  return {
    ...base,
    surface: "grass",
    kerbType: null,
    gripMultiplier: computeSurfaceGripMultiplier(past),
    dragCoefficient: GRASS_DRAG_N_PER_MS,
    kerbRiseMeters: 0,
  };
}

/**
 * The four wheels' grip multipliers, in CAR_WHEELS order, for
 * applyLoadSensitiveFriction. Split out so Car.tsx, AICar.tsx and the
 * headless harness all build the array the same way.
 */
export function wheelSurfaceGrips(
  samples: readonly SurfaceSample[]
): number[] {
  return samples.map((sample) => sample.gripMultiplier);
}

/** Mean extra drag over the wheels - half the car in gravel drags half as hard. */
export function meanSurfaceDrag(samples: readonly SurfaceSample[]): number {
  if (samples.length === 0) return 0;
  let total = 0;
  for (const sample of samples) total += sample.dragCoefficient;
  return total / samples.length;
}
