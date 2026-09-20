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
 * with enough road to the next corner for the driver's risk appetite - a
 * lunge that can't finish before the braking zone is how AI cars end up
 * in the grandstands. Returns a zero decision otherwise, so callers apply
 * it unconditionally.
 *
 * Two gates start a move: range (which grows with aggression) and closing
 * speed. But once started, the move latches (see alreadyAttempting): a
 * committed car alongside no longer needs to prove it is still closing -
 * without the latch the follow discipline (which quite rightly kills
 * closing speed on approach) would strangle every attempt the same tick
 * it starts, and the field would sit in formation forever exactly as
 * before racecraft existed. The latch drops the moment the car is clear
 * (gap < -3), out of road, or out of the throttle zone.
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
  alreadyAttempting: boolean;
}): OvertakeDecision {
  const none: OvertakeDecision = { attempt: false, offsetMeters: 0, paceBonus: 0, urgent: false };
  const aggression = Math.min(1, Math.max(0, args.aggression));
  // Parked/crashed car ahead: squeeze past even without the speed for a
  // real lunge - otherwise one stopped car deadlocks the whole queue
  // behind it (no closing speed ever builds). Seen from far away at
  // speed: the trigger range scales with approach speed so the offset
  // (which ramps at ~1.5 m/s) is fully across before arrival, not still
  // drifting over when the gap closes. Crawling queues pick through
  // anywhere (even mid-corner): below 20 m/s an offset is a maneuver, not
  // a swerve, so the throttle-zone gate is lifted there. This check runs
  // before the zone gate so the squeeze survives corner zones while the
  // queue crawls around.
  if (
    args.leaderSpeedMs < 3 &&
    args.gapMeters < Math.min(80, Math.max(15, args.speedMs * 1.2)) &&
    (args.throttleZone || args.speedMs < 20)
  ) {
    return { attempt: true, offsetMeters: args.overtakeSide * 2.0, paceBonus: 0, urgent: true };
  }
  if (!args.throttleZone) return none;
  if (args.gapMeters < (args.alreadyAttempting ? -3 : 0)) return none;
  if (args.speedMs < 40) return none;
  if (args.gapMeters > 6 + aggression * 10) return none;
  if (!args.alreadyAttempting && args.closingSpeedMs < 0.3) return none;
  // Moves may finish into the braking zone (like real overtakes): the
  // latch drops and the offset washes the moment the zone flips, so the
  // car rejoins the line while braking, not mid-corner. Risk-takers start
  // from further back.
  const risk = Math.min(1, Math.max(0, args.risk));
  if (args.cornerAheadMeters < 80 - risk * 30) return none;
  return {
    attempt: true,
    offsetMeters: args.overtakeSide * (1.6 + aggression * 0.8),
    paceBonus: 0.015 + aggression * 0.015,
    urgent: false,
  };
}

/**
 * Slipstream: tucked behind another car on a fast straight, the follower
 * punches a smaller hole in the air. Sized to actually close a gap over
 * one straight (a couple of percent is the whole ballgame at 70 m/s),
 * capped, straights only - a pace lever, never a steering one.
 */
export function slipstreamBonus(args: {
  gapMeters: number;
  speedMs: number;
  throttleZone: boolean;
}): number {
  if (!args.throttleZone) return 0;
  if (args.speedMs < 45) return 0;
  if (args.gapMeters < 0 || args.gapMeters > 20) return 0;
  return 0.035;
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

/**
 * Squeezing past a slow/stopped obstacle (see the urgent branch of
 * decideOvertake): line-relative offsets are blind - if the carcass sits
 * three meters off the line, a two-meter line offset can steer straight
 * into it. This picks the offset from the obstacle's actual lateral
 * position, in the line frame at the caller's anchor: away from the
 * obstacle, or the driver's preferred side when it sits dead ahead.
 * Returns null when the obstacle is far enough off-line to ignore.
 */
export function squeezeDecision(args: {
  obstacleX: number;
  obstacleZ: number;
  lineX: number;
  lineZ: number;
  lineDirX: number;
  lineDirZ: number;
  overtakeSide: 1 | -1;
}): { offsetMeters: number } | null {
  const vx = args.obstacleX - args.lineX;
  const vz = args.obstacleZ - args.lineZ;
  // Same perpendicular the steering pursues from (see pathFollower's
  // lateral offset): choosing the sign here chooses the rendered side.
  const perpX = -args.lineDirZ;
  const perpZ = args.lineDirX;
  const s = vx * perpX + vz * perpZ;
  if (Math.abs(s) > 3.5) return null;
  const side = s >= 0.5 ? -1 : s <= -0.5 ? 1 : args.overtakeSide;
  return { offsetMeters: side * 2.5 };
}

export interface RaceRival {
  key: string;
  gapMeters: number;
  speedMs: number;
}

export interface RacePaceInput {
  ownSpeedMs: number;
  /** Every other car as a track gap (see trackGapMeters), keyed stably. */
  rivals: RaceRival[];
  throttleZone: boolean;
  cornerAheadMeters: number;
  aggression: number;
  risk: number;
  overtakeSide: 1 | -1;
  /** Traits x difficulty x tires x mistakes - everything but racecraft. */
  basePace: number;
  /** Latched lunge target (see decideOvertake) - the car being passed. */
  alreadyAttemptingKey: string | null;
}

export interface RacePaceOutput {
  paceMult: number;
  decision: OvertakeDecision;
  /** The latched target key, or null when no move is live. */
  attemptKey: string | null;
}

/**
 * One tick of wheel-to-wheel pace: the shared composition every simulated
 * car runs (AICar.tsx live, the headless field test in lockstep), so the
 * game and its tests can never drift apart. Slipstream and the lunge
 * bonus stack; the follow discipline stands down while a latched attempt
 * runs (the car is going around, not queuing - braking it back onto the
 * leader's gearbox mid-pass is what made moves stillborn); yielding
 * applies throughout.
 *
 * The latch keys on the TARGET, not the nearest gap: mid-pass the two
 * cars jostle and the target routinely wobbles a meter behind for a tick
 * - re-targeting the next car up the road at that moment stillbirths the
 * move and reads from outside as perpetual formation driving.
 */
export function composeRacePace(input: RacePaceInput): RacePaceOutput {
  let nearest: RaceRival | null = null;
  let nearestBehindGap = Infinity;
  for (const rival of input.rivals) {
    if (rival.gapMeters >= 0 && (nearest === null || rival.gapMeters < nearest.gapMeters)) {
      nearest = rival;
    }
    if (rival.gapMeters < 0 && rival.gapMeters > nearestBehindGap) {
      nearestBehindGap = rival.gapMeters;
    }
  }
  // Latched target first: same car, even if it wobbles marginally behind.
  let target: RaceRival | null = null;
  if (input.alreadyAttemptingKey !== null) {
    const latched = input.rivals.find((rival) => rival.key === input.alreadyAttemptingKey) ?? null;
    if (latched !== null && latched.gapMeters >= -4) target = latched;
  }
  const aheadGap = target?.gapMeters ?? nearest?.gapMeters ?? Infinity;
  const aheadSpeed = target?.speedMs ?? nearest?.speedMs ?? 0;
  const decision = decideOvertake({
    gapMeters: aheadGap,
    closingSpeedMs: input.ownSpeedMs - aheadSpeed,
    speedMs: input.ownSpeedMs,
    leaderSpeedMs: aheadSpeed,
    throttleZone: input.throttleZone,
    cornerAheadMeters: input.cornerAheadMeters,
    aggression: input.aggression,
    risk: input.risk,
    overtakeSide: input.overtakeSide,
    alreadyAttempting: target !== null,
  });
  const attemptKey = decision.attempt
    ? (target?.key ?? nearest?.key ?? null)
    : null;
  let paceMult =
    input.basePace *
    (1 +
      slipstreamBonus({
        gapMeters: nearest?.gapMeters ?? Infinity,
        speedMs: input.ownSpeedMs,
        throttleZone: input.throttleZone,
      }) +
      decision.paceBonus);
  if (!decision.attempt) {
    paceMult *= followPaceScale({
      gapMeters: nearest?.gapMeters ?? Infinity,
      throttleZone: input.throttleZone,
      aggression: input.aggression,
      leaderSpeedMs: nearest?.speedMs ?? 0,
      ownSpeedMs: input.ownSpeedMs,
    });
  }
  paceMult *= yieldPaceScale({
    gapToFollowerMeters: nearestBehindGap === Infinity ? 99 : nearestBehindGap,
    aggression: input.aggression,
  });
  return { paceMult, decision, attemptKey };
}
