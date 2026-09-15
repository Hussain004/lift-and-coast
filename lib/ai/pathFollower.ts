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
  /**
   * The nearest line point's own zone. Exposed for a future AI energy/
   * aero strategy (plan section 6) - not consumed by anything yet. A
   * first attempt at that (deploy Push-to-Pass and switch to low-drag
   * aero whenever zone === "throttle") flipped the AI car on the real
   * track: "throttle" includes corner-exit acceleration while still
   * turning, and cutting grip or adding engine force there destabilizes
   * it (checked at a full lap-plus, 150s - a 90s check missed it
   * entirely). computeAIControls's throttle/brake decision doesn't know
   * about the boost that gets applied after it, so it can't compensate.
   * Solving this needs the energy decision feeding back into that
   * decision, not a simple gate on zone - deferred, not attempted again
   * without that.
   */
  zone: ThrottleZone;
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
 */
export function computeAIControls(
  line: RacingLinePoint[],
  carX: number,
  carZ: number,
  carYaw: number,
  carSpeedMs: number
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

  const targetSpeed = line[nearest].targetSpeedMs;
  const speedError = targetSpeed - carSpeedMs;
  const throttle = speedError > 0 ? Math.min(1, speedError / SPEED_ERROR_NORMALIZER_MS) : 0;
  const brake = speedError < 0 ? Math.min(1, -speedError / SPEED_ERROR_NORMALIZER_MS) : 0;

  return { throttle, brake, steer, zone: line[nearest].zone };
}
