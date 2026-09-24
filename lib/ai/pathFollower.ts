import type { RacingLinePoint, ThrottleZone } from "../tracks/racingLine";
import { MAX_DECEL_MS2, maxLateralAccelMs2 } from "../tracks/racingLine";

// Plan section 6: "steer toward a lookahead point on the racing line;
// throttle/brake targets derived from curvature ahead (brake *before* the
// corner...)". This is the shared steering/speed brain with two additive,
// default-inert personality inputs - paceScale (driver skill, difficulty,
// tires, mistakes, slipstream) and lateralOffsetMeters (overtake offset,
// ramped by the caller). Both default to the reference behavior, so the
// validated controller below is exactly what shipped before personalities:
// the per-driver differences live in the INPUTS (see lib/ai/personalities
// and lib/ai/racecraft), never in retuned gains - anything that perturbs
// this control law proved chaotically sensitive (see the lookahead and
// boost comments below), and this file keeps that discipline. It reuses
// the exact same physics model as the player's own car (see AICar.tsx) -
// this is just the "brain" plugged in instead of keyboard input.
//
// The target speed at each point is precomputed by racingLine.ts itself
// (a physically-plausible profile shared with the line's own on-track
// color coding), not recomputed here - this used to run its own curvature
// calculation on the fly, but that meant the AI's "how sharp is this turn"
// signal was independent of (and less carefully smoothed than) what's
// actually drawn on the track and the minimap, and it was the raw,
// un-smoothed centerline curvature that produced the "AI wanders off
// track" symptom the smoothed, shared profile fixes.
// Checked against the real Silverstone trimesh over a full 150s run (more
// than a full lap): swept a *fixed* lookahead of 10-35 points with gain
// 0.7-1.2. On Silverstone's fast layout a short fixed lookahead tracks
// tightly over a short run but compounds into large (30m+) off-track
// excursions and occasional near-flips (maxTiltRad approaching 1.0) once a
// full lap's worth of corners has been driven - this system is sensitive
// enough that small tuning changes shift which specific corner becomes the
// failure point, so the fast-track value was picked with real margin from
// the instability band observed at 30+ points, not by chasing the single
// best-looking run.
// Confirmed with actual numbers later (see AIControls.boostEligible's own
// comment and [[lift_and_coast_ai_boost_knife_edge]]): a cross-track
// steering-correction term swept from 0.0005-0.004 found isolated safe
// values (0.0005, 0.003) sandwiched between destabilizing ones (0.001,
// 0.0015, 0.002, 0.004), each failure's worst excursion landing at a
// different lap position (65s/92s/60s/112s) - not one bad track-mesh spot.
// The safe values moved maxOffTrackMeters by ~2%, i.e. did nothing. There is
// no gain here that both matters and survives; this is closed, not
// under-tuned.
//
// The value that sweep validated is a *distance* (25 points = 50m at the
// builder's 2m resample spacing), and a fixed point count only equals that
// distance at the speed it was swept at. Monaco's street layout breaks the
// equivalence: at the Grand Hotel hairpin the car is down to ~12-15 m/s,
// where a fixed 50m preview reaches around the far side of a 15-20m-radius
// loop, so pure pursuit steers straight across the infield - measured as a
// 60m+ "off-track" excursion on every lap. A real driver's preview scales
// with speed, so the lookahead now does too: a 1.0s preview (one second of
// travel), floored at 24m and capped at the swept fast-track 50m. That cap
// is reached at 50 m/s, so on a fast circuit's quickest corners and
// straights it is exactly the value the sweep picked; it only shortens where
// the car is genuinely slow, which is precisely where a long preview
// overshoots a tight corner. The 24m floor is the tight-street value: below
// ~24 m/s (Monaco's hairpin, its chicanes) the preview stops shrinking,
// since an even shorter one would give up the stability the sweep was
// protecting. Re-validated over the full 180s harness on all five registered
// circuits (see tests/trackAIStability.test.ts), where it keeps every car on
// track - Monaco included (worst excursion ~23m, down from 61m+).
const LOOKAHEAD_SECONDS = 1.0;
const LOOKAHEAD_MIN_METERS = 24;
const LOOKAHEAD_MAX_METERS = 50;
/**
 * Corner-entry preview cap (see the curvature clamp in computeAIControls).
 * The speed-scaled preview above is validated for open road, but pure
 * pursuit cuts INSIDE the reference line on any curve tighter than the
 * preview is long - by roughly L^2 / (8R), so a 24m preview round a 25m
 * hairpin runs ~3m inside the line, which is exactly the "AI clips the
 * apex / cuts T1" symptom (Spa's La Source, Monaco's Grand Hotel). The
 * line already rides close to the inside kerb there, so 3m inside is off
 * the ribbon.
 *
 * The fix is the standard one: shrink the preview toward the corner's own
 * radius, using the radius the speed profile itself implies (R = v^2 / a_lat
 * at the profile speed the car is currently chasing - see
 * maxLateralAccelMs2). That is self-consistent: the profile's backward pass
 * already slows the car for corners ahead, so the implied radius tightens on
 * approach AND through the corner, and the preview follows it down. On open
 * road the implied radius is huge and the validated 24-50m preview is
 * untouched; in a hairpin it falls to ~13-16m, where the geometric cutting
 * error is around a meter instead of three.
 *
 * Measured over the 180s-per-track harness on all twenty registered
 * circuits (the run tests/trackAIStability.test.ts performs), sweeping the
 * fraction/floor: the worst off-track excursion of the whole set falls from
 * 7.1m to 3.7m (Monaco; COTA 7.1 -> 1.9, Silverstone 4.1 -> 1.6, Spa 6.1 ->
 * 2.4) at unchanged lap pace and unchanged max-tilt on every circuit except
 * Monaco's barrier-lined streets (0.19 -> 0.34 rad, still far from the flip
 * gate). Tighter values cut the line error further but this control law's
 * documented chaotic sensitivity surfaced instead - at 0.75R Suzuka's
 * max-tilt jumped to 0.74 rad - so this is the tightest setting that keeps
 * the whole set's stability margin intact. Hence the deliberately wide-body
 * floor as well: a preview much under ~14m made the low-speed controller
 * twitchy, exactly as the sweep this file's history describes found.
 */
const LOOKAHEAD_TIGHT_FRACTION = 0.85;
const LOOKAHEAD_TIGHT_MIN_METERS = 14;
const SPEED_ERROR_NORMALIZER_MS = 8; // full throttle/brake once speed error reaches this.
const FAST_AI_THROTTLE_NORMALIZER_MS = 4;
const FAST_AI_THROTTLE_MIN_TARGET_MS = 65;
const FAST_AI_PACE_THRESHOLD = 1.1;
// Brake planning: how far ahead to scan the profile for its minimum. The
// trigger below fires full brake only when the deceleration REQUIRED to
// make that minimum exceeds MAX_DECEL_MS2 - i.e. the profile's own
// backward pass (which plans at exactly that decel) already says the car
// cannot get there in time, so waiting for the proportional law's error
// to grow would arrive hotter still. Ordinary braking (required <= 14)
// stays on the proportional law exactly as validated before; this only
// adds an emergency net for genuine overspeed. The scan reaches 250m so a
// 70 m/s approach to a hairpin is seen in time. (An earlier version fired
// whenever required decel exceeded a fixed 10-12 instead: in Monaco's
// corner-dense lap that meant nearly perpetual full braking and the AI
// crawled - the gate is the profile's own assumption, not a second one.)
const BRAKE_PLANNING_METERS = 250;
const STEER_GAIN = 1.0;

/**
 * Nearest line index for an (x, z) position - exported for the racecraft
 * book (see AICar.tsx), which anchors its corner-ahead scan to the same
 * point the steering pursues from.
 */
export function nearestLineIndex(
  line: RacingLinePoint[],
  x: number,
  z: number,
  warmStartIndex?: number
): number {
  // Warm start (optional): the previous tick's answer for the same car. A
  // moving car's nearest point creeps a few indices per tick, so scanning a
  // bounded window around it is equivalent to the full scan and turns the
  // per-tick O(n) cost (every caller runs at 60Hz per car) into O(window).
  // The window is deliberately generous (±40 ≈ ±80m at the builder's 2m
  // spacing - five seconds of flat-out travel) and its best answer is
  // validated against a hard distance bound before acceptance: a car that
  // jumped (respawn, rewind, spawn) sits outside any sane window and gets
  // the exact full scan instead. The result is identical to the full scan
  // in every case where the car is racing on/around the line.
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
    // 30m ≈ 15 line points of slack - the car can never legitimately be
    // that far off the line while racing, so exceeding it means the warm
    // index is stale and only the exact scan is trustworthy.
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

export interface AIControls {
  throttle: number;
  brake: number;
  steer: number;
  /** The nearest line point's own zone (for HUD/diagnostics). */  zone: ThrottleZone;
  /**
   * The nearest line point's own boostEligible flag (see racingLine.ts) -
   * whether deploying Push-to-Pass right now would actually let the car
   * carry more speed, not a zone it's currently in. A first attempt at AI
   * energy strategy gated boost/aero on zone === "throttle" directly and
   * flipped the car on the real track (checked at a full lap-plus, 150s -
   * a 90s check missed it): "throttle" includes corner-exit acceleration
   * while still turning, and computeAIControls's throttle/brake decision
   * didn't know a boost was coming, so it couldn't compensate - the
   * corner braking point was planned against the UNBOOSTED profile even
   * once boost pushed the car past it. Fixed not by changing this
   * function's control law, but by giving the caller a second, boosted
   * speed profile (see useBoostedSpeed below) whose OWN backward pass
   * already plans the correct, earlier braking point for a boosted
   * approach - so a caller that only sets useBoostedSpeed=true while
   * boostEligible is also true can never ask this function to chase a
   * speed target that ignores the boost being applied.
   *
   * A SECOND attempt built exactly that (this field, useBoostedSpeed,
   * boostedTargetSpeedMs) and wired it into a closed-loop AI+energy-system
   * driver in the 150s headless harness. The corner-braking-point bug
   * above was genuinely fixed - verified: boostEligible is never true
   * where the unboosted profile is already brake-hard, by construction of
   * the shared backward pass (see racingLine.ts's computeCappedSpeedProfile
   * and its own unit tests). It STILL flipped the car, but not from any
   * flaw in this mechanism: the actual flip happened 17+ seconds after the
   * nearest boost deployment ever ran, at a corner nowhere near it. A
   * threshold sweep on the minimum speed-gap required to deploy (the
   * `margin` in the eligibility gate) produced an outright knife-edge, not
   * a safety margin: >3, >3.5, >4.5, >5.5, and >8 all flipped (some
   * violently, 90m+ off-track and negative final speed), while >4, >5, and
   * >6 came back essentially byte-identical to the no-boost baseline
   * (maxTiltRad ~0.113 either way). Picking one of the passing values and
   * shipping it would be superstition, not a fix - there is no reason to
   * believe Silverstone's specific geometry (or any other track, or a
   * slightly different physics/timestep) keeps that same value on the safe
   * side. This confirms the AI's chaotic sensitivity (see the module
   * comment on the lookahead constants) isn't specific to zone-gated boost/aero
   * gating - ANY behavioral perturbation to this AI, however individually
   * well-reasoned, can shift its trajectory enough to walk into an
   * unrelated stability cliff elsewhere on the same lap, arbitrarily far
   * downstream in time. A real fix would need computeAIControls (or the
   * whole pure-pursuit approach) to be robust to its own trajectory
   * drifting from a fixed pre-computed path, not just to the specific
   * boost/aero coupling - a materially bigger redesign than "close the
   * loop on one actuator," not attempted here. boostEligible/
   * boostedTargetSpeedMs/useBoostedSpeed are kept as tested, inert
   * groundwork (unused by anything - see racingLine.test.ts and this
   * file's own tests) since the underlying math is sound and could serve
   * a future attempt, or a player-facing "where would boosting help"
   * overlay, which needs none of the closed-loop AI risk above.
   */
  boostEligible: boolean;
}

/**
 * Distance ahead to the first point demanding real braking: the first
 * profile target more than 12 m/s below current speed, walking up to 400m
 * (a full straight, so an open road reads as room). The racecraft book
 * uses it to refuse lunges that can't finish before the braking zone.
 * Reads the pace-scaled profile, matching what the car chases.
 */
export function cornerAheadMeters(
  line: RacingLinePoint[],
  fromIndex: number,
  speedMs: number,
  paceScale = 1
): number {
  const n = line.length;
  if (n === 0) return 400;
  const clampedPace = Number.isFinite(paceScale) ? Math.min(1.18, Math.max(0.9, paceScale)) : 1;
  let ahead = 0;
  for (let k = 0; k < n && ahead < 400; k++) {
    const point = line[(fromIndex + k) % n];
    if (ahead > 1e-6 && point.targetSpeedMs * clampedPace < speedMs - 12) return ahead;
    ahead += point.distanceToNextMeters;
  }
  return ahead;
}

/**
 * Pure-pursuit-style path following: steers toward a speed-scaled lookahead
 * point on the given racing line, and targets that line's own precomputed speed
 * at the car's current position - which already anticipates corners ahead
 * (see racingLine.ts's backward pass), so no separate curvature lookahead
 * is needed here for speed.
 *
 * carYaw uses the same convention as vehicle.ts's yawFromQuaternion
 * (forward is -Z at yaw 0), and steer uses the same sign as
 * useDriveInput's own input.steer (positive = left, matching LEFT_KEYS).
 *
 * useBoostedSpeed (default false, so every existing caller is unaffected):
 * targets line[nearest].boostedTargetSpeedMs instead of targetSpeedMs -
 * pass true only on ticks where the caller is actually applying boosted
 * engine force this same tick (see AICar.tsx), so the speed this function
 * chases always matches the force actually being applied.
 */
export function computeAIControls(
  line: RacingLinePoint[],
  carX: number,
  carZ: number,
  carYaw: number,
  carSpeedMs: number,
  useBoostedSpeed = false,
  /**
   * Personality/racecraft inputs (plan section 6 depth: AI field). Both
   * default to inert, so every existing caller, test and the headless
   * harness runs exactly the reference behavior:
   * - paceScale multiplies the profile speed targets (driver skill,
   *   difficulty, tire curve, mistakes, slipstream). The brake-planning
   *   scan reads the same scaled profile the throttle law targets, so the
   *   two can never disagree about which speeds are coming.
   * - lateralOffsetMeters shifts the lookahead target sideways from the
   *   line (overtaking offset, ramped in/out by the caller). Bounded and
   *   straights-only by the caller's racecraft book, never by this
   *   function: it just pursues the shifted point with the same gains.
   */
  paceScale = 1,
  lateralOffsetMeters = 0,
  /**
   * Optional warm start for the internal nearest-line search (see
   * nearestLineIndex): pass the index this car used last tick to skip the
   * full O(n) scan. Optional and validated, so every existing caller,
   * test and the headless harness run exactly as before.
   */
  warmStartIndex?: number
): AIControls {
  const n = line.length;
  const nearest = nearestLineIndex(line, carX, carZ, warmStartIndex);
  const nearestPoint = line[nearest];
  // Pace headroom bound: personality/tire/racecraft multipliers stack to
  // ~1.1 at Ace (elite trait x tier x late-race tire curve). The cap bounds
  // CORNERING overspeed above the profile - the first thing that slides -
  // while straight-line overspeed is simply drag-limited. Ace field sims
  // (see tests/aiFieldRace.test.ts) gate the stability of the raised
  // ceiling. The floor is zero: racecraft's follow cap has to be able to
  // stop a car behind a stopped one (a 0.9 floor here silently turned
  // every "stop" into "ram at 90%" - the grid-start and queue shunts).
  const clampedPace = Number.isFinite(paceScale) ? Math.min(1.18, Math.max(0, paceScale)) : 1;
  const unscaledTarget = useBoostedSpeed ? nearestPoint.boostedTargetSpeedMs : nearestPoint.targetSpeedMs;
  const profileTarget = unscaledTarget * clampedPace;
  // The preview geometry below keeps the pace range it was validated over:
  // a follow cap slowing the car must not also shorten the lookahead to a
  // hairpin's length at 60 m/s.
  const steeringTarget = unscaledTarget * Math.max(0.9, clampedPace);

  // Preview distance scales with speed - see LOOKAHEAD_SECONDS above. Walk
  // the line by its own segment lengths rather than assuming a fixed point
  // spacing, so this stays correct if the builder's resample spacing changes.
  // Capped by the corner's own implied radius (see LOOKAHEAD_TIGHT_*): the
  // line's speed profile at this point already reflects every corner it is
  // braking for, so v^2 / a_lat(v) is that corner's radius as the car
  // experiences it, and a preview longer than the corner is what cuts the
  // apex.
  const impliedRadiusMeters =
    steeringTarget > 1
      ? (steeringTarget * steeringTarget) / Math.max(1, maxLateralAccelMs2(steeringTarget))
      : Infinity;
  const curvatureCapMeters = Math.max(
    LOOKAHEAD_TIGHT_MIN_METERS,
    impliedRadiusMeters * LOOKAHEAD_TIGHT_FRACTION
  );
  const lookaheadMeters = Math.min(
    LOOKAHEAD_MAX_METERS,
    Math.max(LOOKAHEAD_MIN_METERS, Math.abs(carSpeedMs) * LOOKAHEAD_SECONDS),
    curvatureCapMeters
  );
  let lookaheadIndex = nearest;
  let previewedMeters = 0;
  while (previewedMeters < lookaheadMeters) {
    previewedMeters += line[lookaheadIndex].distanceToNextMeters;
    lookaheadIndex = (lookaheadIndex + 1) % n;
  }

  const [lookX, , lookZ] = line[lookaheadIndex].position;
  // Overtake offset (see the paceScale/lateralOffsetMeters contract above):
  // shift the pursuit point sideways from the line direction at the
  // lookahead index, so the car runs parallel to the line rather than
  // chasing a rotated point. Zero by default (reference behavior).
  let aimX = lookX;
  let aimZ = lookZ;
  if (lateralOffsetMeters !== 0) {
    const [nextX, , nextZ] = line[(lookaheadIndex + 1) % n].position;
    const dirX = nextX - lookX;
    const dirZ = nextZ - lookZ;
    const len = Math.hypot(dirX, dirZ);
    if (len > 1e-6) {
      aimX = lookX + (-dirZ / len) * lateralOffsetMeters;
      aimZ = lookZ + (dirX / len) * lateralOffsetMeters;
    }
  }
  const dx = aimX - carX;
  const dz = aimZ - carZ;
  // Solving forward = (-sin(yaw), -cos(yaw)) for yaw given a desired
  // forward direction (dx, dz) - same convention as yawFromQuaternion.
  const targetYaw = Math.atan2(-dx, -dz);
  let yawError = targetYaw - carYaw;
  // Wrap to (-pi, pi] so a lookahead point behind-ish the car doesn't
  // demand a near-360-degree steer the wrong way round.
  while (yawError > Math.PI) yawError -= 2 * Math.PI;
  while (yawError < -Math.PI) yawError += 2 * Math.PI;
  const steer = Math.max(-1, Math.min(1, yawError * STEER_GAIN));

  const baseTarget = profileTarget;
  const speedError = baseTarget - carSpeedMs;
  // Ace/strong pace inputs get a more immediate throttle response. The old
  // 8m/s error ramp made a car that was already on target crawl back to it
  // after a small lift, which read as a slow launch even when the target
  // profile was already asking for full power. The target and braking law
  // stay unchanged; only the pedal reaches the command sooner. Restricting
  // this to genuinely fast targets keeps slow street corners on the proven
  // response curve.
  const throttleErrorNormalizerMs =
    clampedPace > FAST_AI_PACE_THRESHOLD && nearestPoint.targetSpeedMs >= FAST_AI_THROTTLE_MIN_TARGET_MS
      ? FAST_AI_THROTTLE_NORMALIZER_MS
      : SPEED_ERROR_NORMALIZER_MS;
  const throttle = speedError > 0 ? Math.min(1, speedError / throttleErrorNormalizerMs) : 0;
  let brake = speedError < 0 ? Math.min(1, -speedError / SPEED_ERROR_NORMALIZER_MS) : 0;

  // Brake planning: the proportional law above only reacts to the speed
  // error AT the car, so at higher entry speeds it ramps in too gently and
  // the car arrives at the corner still carrying too much speed (measured:
  // off-track excursions ballooning past 100m on the faster profile). Scan
  // the profile ahead and brake fully if ANY point ahead demands more
  // decel than the profile's own backward pass ever plans (MAX_DECEL_MS2):
  // by the telescoping construction of that pass, a car exactly on profile
  // never sees required decel above 14 anywhere ahead, so this fires only
  // on genuine overspeed and never second-guesses normal braking (an
  // earlier version compared only against the scan's single minimum, which
  // over-braked for far slow corners past nearer medium ones and the AI
  // crawled). Scans the same profile the throttle law targets (boosted or
  // not), so the two can never disagree about which speeds are coming.
  // Skips distance zero (the car is here - the proportional law owns that
  // comparison, and 0/0 is NaN which would poison the max).
  const speed = Math.abs(carSpeedMs);
  let maxRequiredDecel = -Infinity;
  let scanned = 0;
  for (let k = 0; k < n && scanned < BRAKE_PLANNING_METERS; k++) {
    const i = (nearest + k) % n;
    const point = line[i];
    const candidate =
      (useBoostedSpeed ? point.boostedTargetSpeedMs : point.targetSpeedMs) * clampedPace;
    if (scanned > 1e-6) {
      const required = (speed ** 2 - candidate ** 2) / (2 * scanned);
      if (required > maxRequiredDecel) maxRequiredDecel = required;
    }
    scanned += point.distanceToNextMeters;
  }
  if (maxRequiredDecel > MAX_DECEL_MS2) {
    brake = 1;
  }

  return { throttle: brake === 1 ? 0 : throttle, brake, steer, zone: nearestPoint.zone, boostEligible: nearestPoint.boostEligible };
}
