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

/**
 * Seam-unwrapped gap for racecraft decisions (follow, lunges, squeezes):
 * raw lapCount/progress totals jump by a full lap at the start/finish
 * line, so a car sitting ON the line reads a full lap behind a car eight
 * meters behind it - and the field then rams the "distant" car at full
 * speed with no follow braking and no squeeze. Wrapping the difference
 * into half a lap either way makes physical proximity read correctly: a
 * car eight meters up the road is +8 whether the line lies between or
 * not. Genuinely lapped traffic still works: a car a lap back that's
 * physically alongside IS an imminent encounter (being lapped), and one
 * far away is outside every decision window anyway. Tower and lap logic
 * keep raw totals (see racePosition.ts) - this is for driving decisions
 * only.
 */
export function unwrapGap(
  ownLap: number,
  ownProgressMeters: number,
  otherLap: number,
  otherProgressMeters: number,
  trackLengthMeters: number
): number {
  const raw =
    (otherLap - ownLap) * trackLengthMeters + (otherProgressMeters - ownProgressMeters);
  const half = trackLengthMeters / 2;
  if (raw > half) return raw - trackLengthMeters;
  if (raw < -half) return raw + trackLengthMeters;
  return raw;
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
  throttleZone: boolean;
  cornerAheadMeters: number;
  aggression: number;
  risk: number;
  overtakeSide: 1 | -1;
  alreadyAttempting: boolean;
}): OvertakeDecision {
  const none: OvertakeDecision = { attempt: false, offsetMeters: 0, paceBonus: 0, urgent: false };
  const aggression = Math.min(1, Math.max(0, args.aggression));
  // Slow/stopped obstacles are handled by the squeeze (see composeRacePace
  // with the obstacles list), not here: this function is racing lunges
  // against moving cars only.
  if (!args.throttleZone) return none;
  if (args.gapMeters < (args.alreadyAttempting ? -3 : 0)) return none;
  if (args.speedMs < 40) return none;
  if (args.gapMeters > 10 + aggression * 12) return none;
  if (!args.alreadyAttempting && args.closingSpeedMs < 0.2) return none;
  // Moves may finish into the braking zone (like real overtakes): the
  // latch drops and the offset washes the moment the zone flips, so the
  // car rejoins the line while braking, not mid-corner. Risk-takers start
  // from further back.
  const risk = Math.min(1, Math.max(0, args.risk));
  if (args.cornerAheadMeters < 70 - risk * 30) return none;
  return {
    attempt: true,
    // Properly off-line: a meter of overlap reads as a lunge from the
    // grandstand, two-plus reads as a move even on the minimap.
    offsetMeters: args.overtakeSide * (1.8 + aggression * 0.8),
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
  const stopped = Math.max(0, args.leaderSpeedMs) < 3;
  // Nose-to-tail (under ~3m gap-to-nose with a ~4m car): back OUT instead
  // of matching - sitting inside the leader's gearbox welds the pair, and
  // a sustained deep weld grinds the contact solver into NaN (the frozen
  // Suzuka 20-car starts). Skipped automatically mid-pass (see
  // composeRacePace: the follow discipline stands down while latched).
  if (args.gapMeters < 3) {
    // ...all the way to a stop behind a stopped car: the pace floor below
    // would otherwise ram a parked car at half speed instead of queuing,
    // and a queue that arrives at speed is a pile-up, not a wait.
    if (stopped) return Math.min(1, Math.max(0, (args.gapMeters - 2) * 0.4 / own));
    return Math.min(1, Math.max(0.3, (Math.max(0, args.leaderSpeedMs) - 2) / own));
  }
  // Allowed closing shrinks with the gap: from ~8 m/s at the edge of the
  // window down to matching speeds bumper-to-bumper - and to a full stop
  // behind a stopped car, for the same pile-up reason as above.
  const allowedSpeed =
    Math.max(0, args.leaderSpeedMs) + Math.max(0, args.gapMeters - 2) * (stopped ? 0.4 : 0.8);
  const floor = stopped ? 0 : 0.55;
  return Math.min(1, Math.max(floor, allowedSpeed / own));
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
 * Squeezing past a slow/stopped obstacle: picks the offset from the
 * obstacle's lateral position in the line frame (positive = the side the
 * steering's perpendicular points to - see pathFollower), going around
 * the side it isn't on, or the driver's preferred side when it sits dead
 * ahead. Returns null when the obstacle is far enough off-line to ignore.
 * A line-relative offset alone can steer straight into a carcass sitting
 * meters off the line, which is why this exists.
 */
export function squeezeDecision(args: {
  lateralMeters: number;
  overtakeSide: 1 | -1;
}): { offsetMeters: number } | null {
  if (Math.abs(args.lateralMeters) > 3.5) return null;
  const side =
    args.lateralMeters >= 0.5 ? -1 : args.lateralMeters <= -0.5 ? 1 : args.overtakeSide;
  return { offsetMeters: side * 2.5 };
}

/**
 * Lateral position of an obstacle in the line frame at an anchor point:
 * the signed distance across the track, using the same perpendicular the
 * steering pursues from (see pathFollower's lateral offset).
 */
export function obstacleLateral(
  obstacleX: number,
  obstacleZ: number,
  lineX: number,
  lineZ: number,
  lineDirX: number,
  lineDirZ: number
): number {
  return (obstacleX - lineX) * -lineDirZ + (obstacleZ - lineZ) * lineDirX;
}

/**
 * Merging back to the line while completing a pass: full offset until the
 * nose is past (dead alongside is clean air at a 2.4m separation - wider
 * than the car), then washing out across the four meters ahead - like a
 * real overtake, which finishes by TAKING the line in front, not by
 * merging into the leader's rear quarter. Without the merge, a latched
 * car holds its offset into side contact and the pair slow each other
 * for half the race (measured: -30% distance) instead of resolving.
 */
export function mergeOffsetFactor(gapMeters: number): number {
  if (gapMeters >= 0) return 1;
  if (gapMeters <= -4) return 0;
  return (gapMeters + 4) / 4;
}

export interface RaceRival {
  key: string;
  gapMeters: number;
  speedMs: number;
}

/**
 * A slow/stopped obstacle with its line-frame lateral position (see
 * obstacleLateral): parked cars, crash victims, lapped stragglers
 * crawling far off pace.
 */
export interface RaceObstacle {
  gapMeters: number;
  speedMs: number;
  lateralMeters: number;
}

export interface RacePaceInput {
  ownSpeedMs: number;
  /** Every other car as a track gap (see trackGapMeters), keyed stably. */
  rivals: RaceRival[];
  /** Slow/stopped obstacles with lateral positions (see RaceObstacle).
   * Optional (defaults to none) for callers with no position data. */
  obstacles?: RaceObstacle[];
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
    throttleZone: input.throttleZone,
    cornerAheadMeters: input.cornerAheadMeters,
    aggression: input.aggression,
    risk: input.risk,
    overtakeSide: input.overtakeSide,
    alreadyAttempting: target !== null,
  });
  // Squeeze around a slow/stopped obstacle (see squeezeDecision): takes
  // precedence over any racing lunge - a parked car is a wall with a
  // choice of sides, and picking wrong side by line offset alone steers
  // into it. Seen from far away at speed so the offset is fully across
  // before arrival; crawling queues pick through anywhere, since below
  // 20 m/s an offset is a maneuver, not a swerve.
  let squeeze: { offsetMeters: number } | null = null;
  if (!decision.attempt) {
    const range = Math.min(80, Math.max(15, input.ownSpeedMs * 1.2));
    let bestGap = Infinity;
    for (const obstacle of input.obstacles ?? []) {
      if (obstacle.speedMs >= 3) continue;
      if (obstacle.gapMeters < -2 || obstacle.gapMeters > range) continue;
      if (!input.throttleZone && input.ownSpeedMs >= 20) continue;
      if (obstacle.gapMeters < bestGap) {
        const placed = squeezeDecision({
          lateralMeters: obstacle.lateralMeters,
          overtakeSide: input.overtakeSide,
        });
        if (placed !== null) {
          squeeze = placed;
          bestGap = obstacle.gapMeters;
        }
      }
    }
  }
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
  if (squeeze !== null) {
    // Crawl, don't rush: the offset needs time to unfold, and arriving
    // hot is what turns a squeeze into a shunt. A ~8 m/s target threads
    // the gap instead of punting the obstacle. No latch key: the squeeze
    // re-triggers deterministically while conditions hold, and the ramp
    // smooths the odd tick it flickers.
    paceMult = Math.min(paceMult, 0.12);
  } else if (!decision.attempt) {
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
  if (squeeze !== null) {
    return {
      paceMult,
      decision: { attempt: true, offsetMeters: squeeze.offsetMeters, paceBonus: 0, urgent: true },
      attemptKey,
    };
  }
  return { paceMult, decision, attemptKey };
}
