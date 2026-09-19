import type { RacingLinePoint, ThrottleZone } from "../tracks/racingLine";
import { MAX_DECEL_MS2 } from "../tracks/racingLine";

// Plan section 6: "steer toward a lookahead point on the racing line;
// throttle/brake targets derived from curvature ahead (brake *before* the
// corner...)". This is the first, single-car version - no racecraft, no
// opponent awareness, no difficulty tiers (all explicitly later work in the
// same plan section). It reuses the exact same physics model as the
// player's own car (see AICar.tsx) - this is just the "brain" plugged in
// instead of keyboard input.
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
const SPEED_ERROR_NORMALIZER_MS = 8; // full throttle/brake once speed error reaches this.
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

function nearestLineIndex(line: RacingLinePoint[], x: number, z: number): number {
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
  /** The nearest line point's own zone (for HUD/diagnostics). */
  zone: ThrottleZone;
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
  useBoostedSpeed = false
): AIControls {
  const n = line.length;
  const nearest = nearestLineIndex(line, carX, carZ);

  // Preview distance scales with speed - see LOOKAHEAD_SECONDS above. Walk
  // the line by its own segment lengths rather than assuming a fixed point
  // spacing, so this stays correct if the builder's resample spacing changes.
  const lookaheadMeters = Math.min(
    LOOKAHEAD_MAX_METERS,
    Math.max(LOOKAHEAD_MIN_METERS, Math.abs(carSpeedMs) * LOOKAHEAD_SECONDS)
  );
  let lookaheadIndex = nearest;
  let previewedMeters = 0;
  while (previewedMeters < lookaheadMeters) {
    previewedMeters += line[lookaheadIndex].distanceToNextMeters;
    lookaheadIndex = (lookaheadIndex + 1) % n;
  }

  const [lookX, , lookZ] = line[lookaheadIndex].position;
  const dx = lookX - carX;
  const dz = lookZ - carZ;
  // Solving forward = (-sin(yaw), -cos(yaw)) for yaw given a desired
  // forward direction (dx, dz) - same convention as yawFromQuaternion.
  const targetYaw = Math.atan2(-dx, -dz);
  let yawError = targetYaw - carYaw;
  // Wrap to (-pi, pi] so a lookahead point behind-ish the car doesn't
  // demand a near-360-degree steer the wrong way round.
  while (yawError > Math.PI) yawError -= 2 * Math.PI;
  while (yawError < -Math.PI) yawError += 2 * Math.PI;
  const steer = Math.max(-1, Math.min(1, yawError * STEER_GAIN));

  const nearestPoint = line[nearest];
  const baseTarget = useBoostedSpeed ? nearestPoint.boostedTargetSpeedMs : nearestPoint.targetSpeedMs;
  const speedError = baseTarget - carSpeedMs;
  const throttle = speedError > 0 ? Math.min(1, speedError / SPEED_ERROR_NORMALIZER_MS) : 0;
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
    const candidate = useBoostedSpeed ? point.boostedTargetSpeedMs : point.targetSpeedMs;
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
