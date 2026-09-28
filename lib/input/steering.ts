/**
 * Ramp brake input up to full over half a second instead of snapping to 1
 * instantly.
 *
 * This is NOT a taste call, it is the documented anti-pitch guard: at the
 * engine force this project uses, slamming full brake the instant the key is
 * pressed after building real speed pitches the chassis hard enough to flip it
 * (tilt passes the 0.6 rad flip threshold at around 0.7 of brake applied as a
 * single step). The raycast suspension has no anti-dive geometry to absorb a
 * full-force step input. Ramping the input itself fixed it with a wide margin
 * (~0.3 rad against a 0.6 threshold), including combined with hard throttle
 * boost and trail-braking steer. Releasing stays instant - only the sudden
 * application caused the instability, not the release.
 *
 * LIVES HERE, not in one input path, because it is a property of the CAR, not
 * of a particular device: any input source that can command full brake in one
 * frame has to pass through it or reintroduce the flip. useDriveInput applies
 * it to the keyboard and the gamepad, and app/TimeAttack.tsx applies it to its
 * own keyboard and touch controls, both reading this one constant - so the two
 * paths cannot drift apart and one of them cannot ship an unflipped car.
 *
 * This is also what the race calls "ABS": toggling absEnabled off removes it,
 * letting brake input through instantly. That is the intended tradeoff, not a
 * missing safety check.
 */
export const BRAKE_RAMP_SECONDS = 0.5;

/**
 * Rate-limited steering toward a target lock, with return-to-center when
 * no steering input is held. Keeps keyboard steering from snapping straight
 * to full lock (plan section 5, "Input shaping").
 */
export function stepSteering(
  current: number,
  target: number,
  dt: number,
  rate: number,
  centerRate: number
): number {
  const towardTarget = target !== 0;
  const activeRate = towardTarget ? rate : centerRate;
  const goal = towardTarget ? target : 0;
  const delta = goal - current;
  const maxStep = activeRate * dt;
  if (Math.abs(delta) <= maxStep) return goal;
  return current + Math.sign(delta) * maxStep;
}
