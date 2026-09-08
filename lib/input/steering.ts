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
