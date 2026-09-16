import type { RacingLinePoint, ThrottleZone } from "../tracks/racingLine";

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
// than a full lap): swept lookahead 10-35 points with gain 0.7-1.2. Shorter
// lookaheads track tightly over a short run but compound into large
// (30m+) off-track excursions and occasional near-flips (maxTiltRad
// approaching 1.0) once a full lap's worth of corners has been driven -
// this system is sensitive enough that small tuning changes shift which
// specific corner becomes the failure point, so this value was picked with
// real margin from the instability band observed at 30+ points, not by
// chasing the single best-looking run.
const LOOKAHEAD_POINTS = 25;
const SPEED_ERROR_NORMALIZER_MS = 8; // full throttle/brake once speed error reaches this.
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
   * comment on LOOKAHEAD_POINTS) isn't specific to zone-gated boost/aero
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
 * Pure-pursuit-style path following: steers toward a fixed lookahead point
 * on the given racing line, and targets that line's own precomputed speed
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

  const [lookX, , lookZ] = line[(nearest + LOOKAHEAD_POINTS) % n].position;
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
  const targetSpeed = useBoostedSpeed ? nearestPoint.boostedTargetSpeedMs : nearestPoint.targetSpeedMs;
  const speedError = targetSpeed - carSpeedMs;
  const throttle = speedError > 0 ? Math.min(1, speedError / SPEED_ERROR_NORMALIZER_MS) : 0;
  const brake = speedError < 0 ? Math.min(1, -speedError / SPEED_ERROR_NORMALIZER_MS) : 0;

  return { throttle, brake, steer, zone: nearestPoint.zone, boostEligible: nearestPoint.boostEligible };
}
