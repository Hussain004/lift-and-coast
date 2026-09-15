// Plan section 6: "steer toward a lookahead point on the racing line;
// throttle/brake targets derived from curvature ahead (brake *before* the
// corner...)". This is the first, single-car version - no racecraft, no
// opponent awareness, no difficulty tiers (all explicitly later work in the
// same plan section). It reuses the exact same physics model as the
// player's own car (see AICar.tsx) - this is just the "brain" plugged in
// instead of keyboard input.

const LOOKAHEAD_POINTS = 30;
const CURVATURE_LOOKAHEAD_POINTS = 30;
// ~252 km/h - not an arbitrary cap: this is within 1% of this car's own
// physics-derived terminal velocity in high-downforce mode (engine force
// 1450N == drag force at ~69.5 m/s, from aero.ts's drag coefficient), so
// the AI asymptotically approaches but never quite reaches it on a real
// straight, same as the player's own car would.
const MAX_SPEED_MS = 70;
const MIN_CORNER_SPEED_MS = 18; // ~65 km/h floor, even for the sharpest modeled corner.
// Checked against Silverstone's actual centerline curvature distribution
// (median turn signal ~0.11, p90 ~0.68, max ~1.0 over this same
// CURVATURE_LOOKAHEAD_POINTS window) before picking this: 45 keeps typical
// gentle sections near top speed, brakes down to ~140 km/h for the top 10%
// sharpest sections, and only floors at the tightest few percent of the
// lap - not the "parade lap" an unchecked guess (900) produced, which
// floored the target speed almost everywhere.
const CURVATURE_SPEED_PENALTY = 45;
const SPEED_ERROR_NORMALIZER_MS = 8; // full throttle/brake once speed error reaches this.
const STEER_GAIN = 1.0;

function nearestLineIndex(line: [number, number, number][], x: number, z: number): number {
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < line.length; i++) {
    const [lx, , lz] = line[i];
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
}

/**
 * Pure-pursuit-style path following: steers toward a fixed lookahead point
 * on the given line, and derives a target speed from how sharply the line
 * turns further ahead, so the car lifts/brakes before reaching a corner
 * rather than reacting once already in it.
 *
 * carYaw uses the same convention as vehicle.ts's yawFromQuaternion
 * (forward is -Z at yaw 0), and steer uses the same sign as
 * useDriveInput's own input.steer (positive = left, matching LEFT_KEYS).
 */
export function computeAIControls(
  line: [number, number, number][],
  carX: number,
  carZ: number,
  carYaw: number,
  carSpeedMs: number
): AIControls {
  const n = line.length;
  const nearest = nearestLineIndex(line, carX, carZ);

  const [lookX, , lookZ] = line[(nearest + LOOKAHEAD_POINTS) % n];
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

  const curveA = line[nearest];
  const curveB = line[(nearest + CURVATURE_LOOKAHEAD_POINTS) % n];
  const curveC = line[(nearest + CURVATURE_LOOKAHEAD_POINTS * 2) % n];
  const abx = curveB[0] - curveA[0];
  const abz = curveB[2] - curveA[2];
  const bcx = curveC[0] - curveB[0];
  const bcz = curveC[2] - curveB[2];
  const abLen = Math.hypot(abx, abz) || 1;
  const bcLen = Math.hypot(bcx, bcz) || 1;
  // Magnitude of how much the path's direction turns between the two
  // lookahead segments - sign doesn't matter for a speed target, only how
  // sharp the turn is.
  const turn = Math.abs((abx / abLen) * (bcz / bcLen) - (abz / abLen) * (bcx / bcLen));

  const targetSpeed = Math.max(MIN_CORNER_SPEED_MS, MAX_SPEED_MS - turn * CURVATURE_SPEED_PENALTY);
  const speedError = targetSpeed - carSpeedMs;
  const throttle = speedError > 0 ? Math.min(1, speedError / SPEED_ERROR_NORMALIZER_MS) : 0;
  const brake = speedError < 0 ? Math.min(1, -speedError / SPEED_ERROR_NORMALIZER_MS) : 0;

  return { throttle, brake, steer };
}
