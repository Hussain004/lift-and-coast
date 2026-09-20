// Wheel-to-wheel decisions for the AI field: gap math, overtake attempts,
// slipstream, follow behavior, and yielding. Pure over progress data (see
// RaceProgress in racePosition.ts), so the whole racecraft book is
// unit-testable without physics - the actual steering stays in
// pathFollower.ts, which only ever receives a bounded lateral offset and a
// pace scale from this module's decisions.
export interface ProgressLike {
  lapCount: number;
  progressMeters: number;
  speedMs?: number;
}

/** Signed gap in meters from own nose to other's nose, along the track. */
export function trackGapMeters(
  own: ProgressLike,
  other: ProgressLike,
  trackLengthMeters: number
): number {
  const total = (p: ProgressLike): number => p.lapCount * trackLengthMeters + p.progressMeters;
  return total(other) - total(own);
}

export interface OvertakeDecision {
  attempt: boolean;
  /** Lateral offset in meters, already sided (see overtakeSide). */
  offsetMeters: number;
  /** Pace bonus while lunging (extra target speed, straights only). */
  paceBonus: number;
  /** Squeezing past a stopped car (not a racing lunge): the caller ramps
   * the offset twice as fast - at crawl speed there is no swerve risk,
   * and a slow ramp would still be unfolding at contact. */
  urgent: boolean;
}

/**
 * Whether to go for a move this tick. Straights only (zone throttle),
 * closing on the car ahead, with enough road to the next corner for the
 * driver's risk appetite - a lunge that can't finish before the braking
 * zone is how AI cars end up in the grandstands. Returns a zero decision
 * otherwise, so callers apply it unconditionally.
 */
export function decideOvertake(args: {
  gapMeters: number;
  closingSpeedMs: number;
  speedMs: number;
  leaderSpeedMs: number;
  throttleZone: boolean;
  cornerAheadMeters: number;
  aggression: number;
  risk: number;
  overtakeSide: 1 | -1;
}): OvertakeDecision {
  const none: OvertakeDecision = { attempt: false, offsetMeters: 0, paceBonus: 0, urgent: false };
  const aggression = Math.min(1, Math.max(0, args.aggression));
  if (!args.throttleZone) return none;
  if (args.gapMeters < 0) return none;
  // Parked/crashed car ahead: squeeze past even without the speed for a
  // real lunge - otherwise one stopped car deadlocks the whole queue
  // behind it (no closing speed ever builds). Seen from far away at
  // speed: the trigger range scales with approach speed so the offset
  // (which ramps at ~1.5 m/s) is fully across before arrival, not still
  // drifting over when the gap closes.
  if (args.leaderSpeedMs < 3 && args.gapMeters < Math.min(80, Math.max(15, args.speedMs * 1.2))) {
    return { attempt: true, offsetMeters: args.overtakeSide * 2.0, paceBonus: 0, urgent: true };
  }
  if (args.speedMs < 40) return none;
  if (args.gapMeters > 6 + aggression * 10) return none;
  if (args.closingSpeedMs < 1) return none;
  const risk = Math.min(1, Math.max(0, args.risk));
  if (args.cornerAheadMeters < 120 - risk * 60) return none;
  return {
    attempt: true,
    offsetMeters: args.overtakeSide * (1.2 + aggression * 0.6),
    paceBonus: 0.015 + aggression * 0.015,
    urgent: false,
  };
}

/**
 * Slipstream: tucked behind another car on a fast straight, the follower
 * punches a smaller hole in the air. Small (+2%), capped, straights only -
 * a pace lever, never a steering one.
 */
export function slipstreamBonus(args: {
  gapMeters: number;
  speedMs: number;
  throttleZone: boolean;
}): number {
  if (!args.throttleZone) return 0;
  if (args.speedMs < 45) return 0;
  if (args.gapMeters < 0 || args.gapMeters > 15) return 0;
  return 0.02;
}

/**
 * Follow behavior: never wear the leader's gearbox. An adaptive cruise
 * that allows closing gently from distance but matches the leader's speed
 * when tucked in - in corners AND on straights, because a pace spread
 * guarantees fast cars arrive at the back of slow ones on the start
 * straight too, not just in braking zones (a Lap-1 pile-up is how this
 * was found). Aggressive drivers sit closer and accept more closing.
 */
export function followPaceScale(args: {
  gapMeters: number;
  throttleZone: boolean;
  aggression: number;
  leaderSpeedMs: number;
  ownSpeedMs: number;
}): number {
  const aggression = Math.min(1, Math.max(0, args.aggression));
  if (args.gapMeters < 0) return 1;
  // Cautious drivers start managing the gap from further out.
  const followGap = (args.throttleZone ? 14 : 6) + (1 - aggression) * 8;
  if (args.gapMeters > followGap) return 1;
  const own = Math.max(1, args.ownSpeedMs);
  // Allowed closing shrinks with the gap: from ~8 m/s at the edge of the
  // window down to matching speeds bumper-to-bumper.
  const allowedSpeed = Math.max(0, args.leaderSpeedMs) + Math.max(0, args.gapMeters - 2) * 0.8;
  return Math.min(1, Math.max(0.55, allowedSpeed / own));
}

/**
 * Yielding: a cautious leader with a rival fully alongside gives room with
 * a small lift instead of chopping across - again a pace lever, not a
 * steering one. Returns 1 (no yield) for assertive defenders.
 */
export function yieldPaceScale(args: {
  gapToFollowerMeters: number;
  aggression: number;
}): number {
  const aggression = Math.min(1, Math.max(0, args.aggression));
  if (aggression > 0.35) return 1;
  if (args.gapToFollowerMeters < -3 || args.gapToFollowerMeters > 3) return 1;
  return 0.98;
}
