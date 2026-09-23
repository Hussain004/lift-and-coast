// Wheel-to-wheel racecraft for the AI field. Every decision here acts
// through two levers pathFollower.ts already understands - a pace scale on
// the speed profile and a lateral offset from the racing line - so the
// validated steering law itself is never retuned per car (see
// pathFollower.ts on why). One entry point, stepRacecraft, is shared
// verbatim by the live car (AICar.tsx) and the headless field sim
// (tests/helpers/fieldSim.ts), so the game and its race gates can't drift.
//
// The model is lane awareness. Every other car is placed in the line frame
// (a gap along the lap, a lateral across it), and three rules sit on top:
// - Never steer into a car you overlap with. Cars alongside bound the
//   offset to their own side of the road ("the band"), so a defender can't
//   turn into an attacker on its inside and a passer can't cut back until
//   it is clear - the T-bone mechanism of the previous generation, which
//   picked a passing side from a per-driver hash and merged on a timer.
// - Follow only the car in your lane, at a real following distance with a
//   stopping-distance speed cap, so a stopped car ahead is a stop, not a
//   ram, and a car one lane over is someone to race, not someone to queue
//   behind (the formation train).
// - Pick passing sides from the road: room to each edge (see LineRoom), the
//   inside of the next corner, and who is already there.
import { cornerAheadMeters } from "./pathFollower";
import { overrideModeActive } from "../physics/energy";
import { maxLateralAccelMs2, type RacingLinePoint, type ThrottleZone } from "../tracks/racingLine";
import type { LineRoom } from "../tracks/racingLineCache";

/** Bodies overlap lengthwise below this nose-to-nose gap (4m cars). */
export const OVERLAP_METERS = 5;
/** Minimum centre-to-centre spacing across the track side by side (the car
 * is ~1.9m wide over the wheels). */
export const SIDE_BY_SIDE_METERS = 2.5;
/** Where an attacker aims beside its target. */
const PASS_LANE_METERS = 2.9;
/** Two cars are in the same lane when their centres are closer across. */
const LANE_HALF_WIDTH_METERS = 1.8;
/** No attacks or defending while a standing start sorts itself out;
 * avoidance and following run from the green light. */
const LAUNCH_HOLD_SECONDS = 5;
const ATTACK_TIMEOUT_SECONDS = 10;
const RETRY_COOLDOWN_SECONDS = 4;
/** Offset ramp across the track: a drift, never a swerve... */
const LATERAL_RATE_MS = 1.6;
/** ...unless a car alongside is pushing us over. */
const EVASIVE_RATE_MS = 3.2;
/** Planning deceleration for the follow cap - well inside the 14 m/s^2
 * the profile brakes at, so a queue forms without anyone locking up. */
const FOLLOW_DECEL_MS2 = 9;
const FOLLOW_SCAN_METERS = 250;

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
 * Seam-unwrapped gap for driving decisions: raw lapCount/progress totals
 * jump by a full lap at the start/finish line, so a car sitting ON the line
 * reads a full lap behind a car eight meters behind it. Wrapping the
 * difference into half a lap either way makes physical proximity read
 * correctly. Tower and lap logic keep raw totals (see racePosition.ts).
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

/**
 * Signed distance across the track in the line frame at an anchor point:
 * the same perpendicular the steering pursues its offset along (see
 * pathFollower), so a lateral read here and an offset handed there mean
 * the same thing.
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

/** A world position's lateral in the line frame at a given line index. */
export function lateralAtLineIndex(line: RacingLinePoint[], index: number, x: number, z: number): number {
  const n = line.length;
  const a = line[((index % n) + n) % n].position;
  const b = line[(((index + 1) % n) + n) % n].position;
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const len = Math.hypot(dx, dz) || 1;
  return obstacleLateral(x, z, a[0], a[2], dx / len, dz / len);
}

/**
 * Exact along-track gap for a nearby car. Progress readings are quantized
 * to the centerline spacing (~2m), which at bumper range is the difference
 * between a gap and a touch - so within 25m the gap is re-measured as the
 * projection of the actual separation onto the line direction.
 */
export function refineGap(
  coarseGapMeters: number,
  ownX: number,
  ownZ: number,
  otherX: number,
  otherZ: number,
  lineDirX: number,
  lineDirZ: number
): number {
  if (Math.abs(coarseGapMeters) > 25) return coarseGapMeters;
  return (otherX - ownX) * lineDirX + (otherZ - ownZ) * lineDirZ;
}

/** Unit line direction at a line index (for refineGap). */
export function lineDirectionAt(line: RacingLinePoint[], index: number): { x: number; z: number } {
  const n = line.length;
  const a = line[((index % n) + n) % n].position;
  const b = line[(((index + 1) % n) + n) % n].position;
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
  return { x: (b[0] - a[0]) / len, z: (b[2] - a[2]) / len };
}

/** Line index for a progress reading (progress is index / n * length -
 * see checkTrackLimits and trackProgress - and the line shares indices
 * with the centerline). */
export function lineIndexAtProgress(progressMeters: number, trackLengthMeters: number, n: number): number {
  const i = Math.round((progressMeters / trackLengthMeters) * n);
  return ((i % n) + n) % n;
}

/**
 * Push-to-Pass strategy (see lib/physics/energy.ts - the AI runs the same
 * harvest/deploy battery as the player). A live attack dumps whatever is
 * left: the pass is now, not later. Otherwise deployment is an aggression
 * dial. boostEligible (see racingLine.ts) keeps deploy off braking zones,
 * and the caller switches the speed targets to the precomputed boosted
 * profile on the same ticks (pathFollower's useBoostedSpeed contract).
 */
export function shouldDeployBoost(args: {
  boostEligible: boolean;
  batteryFraction: number;
  aggression: number;
  attemptingLunge: boolean;
}): boolean {
  if (!args.boostEligible) return false;
  const aggression = clamp01(args.aggression);
  if (args.attemptingLunge) return args.batteryFraction > 0.05;
  return args.batteryFraction > 1 - aggression * 0.55;
}

/**
 * Slipstream: tucked in behind another car on a fast straight, the
 * follower punches a smaller hole in the air - worth 5% out to 35m, enough
 * for a caught-up car to arrive in passing range with a run. A pace lever
 * only.
 */
export function slipstreamBonus(args: { gapMeters: number; speedMs: number; throttleZone: boolean }): number {
  if (!args.throttleZone) return 0;
  if (args.speedMs < 35) return 0;
  if (args.gapMeters < 0 || args.gapMeters > 35) return 0;
  return 0.05;
}

/**
 * Following distance: a car length plus a time gap that shrinks with
 * aggression (0.16s cautious, 0.08s for a dive-bomber) - ~14m at 70 m/s
 * for a midfielder, a couple of meters of daylight when crawling. An
 * attacker closing on its own target runs a much shorter one: it is
 * about to be beside the car, not behind it.
 */
export function followGapMeters(
  ownSpeedMs: number,
  aggression: number,
  attackTarget: boolean,
  leaderSpeedMs = Infinity
): number {
  const v = Math.max(0, ownSpeedMs);
  if (attackTarget) return 5 + 0.02 * v;
  // Behind a stationary car, stop with room to steer round it - a car
  // can't move sideways without rolling forward.
  const standoff = leaderSpeedMs < 1 ? 12 : 5.5;
  return standoff + (0.12 - 0.09 * clamp01(aggression)) * v;
}

/**
 * Highest speed that still stops at the following distance behind a car
 * doing leaderSpeedMs: v = sqrt(vL^2 + 2 a e) for gap excess e, and a
 * proportional back-off inside the distance. Reaches out 250m, so a
 * stopped car past a blind crest at 80 m/s is a braking zone, not a wall.
 */
export function followSpeedCapMs(gapMeters: number, leaderSpeedMs: number, followGap: number): number {
  const vL = Math.max(0, leaderSpeedMs);
  const excess = gapMeters - followGap;
  if (excess >= 0) return Math.sqrt(vL * vL + 2 * FOLLOW_DECEL_MS2 * excess);
  return Math.max(0, vL + 1.5 * excess);
}

/**
 * Lateral bounds for this car's offset from the cars overlapping it: each
 * one closes the road on its own side at SIDE_BY_SIDE_METERS from its
 * centre, on top of the track-edge room. A car in the same lane at bumper
 * range is a queue, not a side-by-side - the follow cap owns it. Returns
 * lo > hi when the car is sandwiched with no legal line at all.
 */
export function lateralBand(args: {
  ownLateralMeters: number;
  cars: readonly FieldCarView[];
  roomPlusMeters: number;
  roomMinusMeters: number;
}): { lo: number; hi: number } {
  let lo = -args.roomMinusMeters;
  let hi = args.roomPlusMeters;
  for (const car of args.cars) {
    if (car.lateralMeters === null) continue;
    if (Math.abs(car.gapMeters) >= OVERLAP_METERS) continue;
    const across = car.lateralMeters - args.ownLateralMeters;
    if (Math.abs(across) < 1 && Math.abs(car.gapMeters) > 4) continue;
    if (across >= 0) hi = Math.min(hi, car.lateralMeters - SIDE_BY_SIDE_METERS);
    else lo = Math.max(lo, car.lateralMeters + SIDE_BY_SIDE_METERS);
  }
  return { lo, hi };
}

/** Another car as seen from one AI car this tick. */
export interface FieldCarView {
  key: string;
  /** Seam-unwrapped track gap (see unwrapGap): + = ahead. */
  gapMeters: number;
  /** Raw race-distance difference (laps included) - lapping detection. */
  rawGapMeters?: number;
  speedMs: number;
  /** Signed distance across the line at the car's own position (see
   * lateralAtLineIndex), or null when unknown - unknown cars are treated
   * as in-lane (followed) but never as alongside (bounding). */
  lateralMeters: number | null;
}

/** The racing line around one car's anchor point (see lineContextAt). */
export interface LineContext {
  cornerAheadMeters: number;
  throttleZone: boolean;
  /** Usable room off the line toward + / - over the steering preview. */
  roomPlusMeters: number;
  roomMinusMeters: number;
  /** Inside of the next corner: +1 / -1, 0 when none is near. */
  cornerSign: -1 | 0 | 1;
  /** Which way the line is bending right here: +1 / -1, 0 on a straight. */
  curveSign: -1 | 0 | 1;
  /** Corner radius the profile implies here (v^2 / a_lat). */
  impliedRadiusMeters: number;
  /** The unscaled profile target at the anchor - converts speed caps into
   * the pace scale pathFollower consumes. */
  profileTargetMs: number;
}

/** Room is taken as the tightest point over this much road ahead - the
 * steering pursues a point up to ~50m out, so an offset that fits here but
 * not at the apex would aim the car off the road. */
const ROOM_PREVIEW_METERS = 55;

export function lineContextAt(
  line: RacingLinePoint[],
  room: LineRoom,
  anchor: number,
  speedMs: number,
  pace: number,
  zone: ThrottleZone
): LineContext {
  const n = line.length;
  let roomPlus = Infinity;
  let roomMinus = Infinity;
  let walked = 0;
  for (let k = 0; k < n && walked < ROOM_PREVIEW_METERS; k++) {
    const i = (anchor + k) % n;
    roomPlus = Math.min(roomPlus, room.plus[i]);
    roomMinus = Math.min(roomMinus, room.minus[i]);
    walked += line[i].distanceToNextMeters;
  }
  const a = line[(anchor - 6 + n) % n].position;
  const b = line[(anchor - 5 + n) % n].position;
  const c = line[(anchor + 5) % n].position;
  const d = line[(anchor + 6) % n].position;
  const cross = (b[0] - a[0]) * (d[2] - c[2]) - (b[2] - a[2]) * (d[0] - c[0]);
  const profileTarget = line[anchor].targetSpeedMs;
  const target = profileTarget * pace;
  return {
    cornerAheadMeters: cornerAheadMeters(line, anchor, speedMs, pace),
    throttleZone: zone === "throttle",
    roomPlusMeters: Number.isFinite(roomPlus) ? roomPlus : 0,
    roomMinusMeters: Number.isFinite(roomMinus) ? roomMinus : 0,
    cornerSign: room.cornerSign[anchor] as -1 | 0 | 1,
    curveSign: cross > 1e-3 ? 1 : cross < -1e-3 ? -1 : 0,
    impliedRadiusMeters: target > 1 ? (target * target) / Math.max(1, maxLateralAccelMs2(target)) : Infinity,
    profileTargetMs: profileTarget,
  };
}

export interface RacecraftState {
  /** Current (ramped) lateral offset handed to the steering. */
  offset: number;
  /** False until the first tick adopts the car's real lateral (grid
   * columns start off the line and must not converge onto it blindly). */
  initialized: boolean;
  attemptKey: string | null;
  attemptSide: -1 | 0 | 1;
  attemptSeconds: number;
  /** A just-failed target: no second look for a few seconds. */
  cooldownKey: string | null;
  cooldownSeconds: number;
  /** Latched defence - one move per attack, never changed mid-defence. */
  defendKey: string | null;
  defendSide: -1 | 0 | 1;
  /** Seconds since this car started racing (launch hold clock). */
  raceSeconds: number;
}

export function createRacecraftState(): RacecraftState {
  return {
    offset: 0,
    initialized: false,
    attemptKey: null,
    attemptSide: 0,
    attemptSeconds: 0,
    cooldownKey: null,
    cooldownSeconds: 0,
    defendKey: null,
    defendSide: 0,
    raceSeconds: 0,
  };
}

/** Forget lanes and latches (respawn, rewind, reset) - the next tick adopts
 * wherever the car now is. The launch clock survives. */
export function resetRacecraftState(state: RacecraftState): void {
  const raceSeconds = state.raceSeconds;
  Object.assign(state, createRacecraftState(), { raceSeconds });
}

export interface RacecraftInput {
  ownSpeedMs: number;
  ownLateralMeters: number;
  /** Traits x difficulty x tires x mistakes - everything but racecraft. */
  basePace: number;
  cars: readonly FieldCarView[];
  line: LineContext;
  aggression: number;
  risk: number;
  overtakeSide: 1 | -1;
  dt: number;
  trackLengthMeters: number;
  boostEligible: boolean;
  batteryFraction: number;
  mistakeActive: boolean;
}

export interface RacecraftOutput {
  paceMult: number;
  deploy: boolean;
  attempting: boolean;
  /** Held up behind a slow or stopped car (stuck detection must not
   * mistake a queue for a beached car). */
  blocked: boolean;
  /** The lateral offset to hand pathFollower this tick (the ramped offset,
   * stretched at walking pace when turning out round a stopped car). */
  steerOffsetMeters: number;
  /** Within a second of the car ahead: Manual Override Mode (energy.ts). */
  override: boolean;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * One tick of wheel-to-wheel driving for one AI car. Mutates `state` (the
 * offset ramp and the attack/defence latches) and returns the pace
 * multiplier for pathFollower plus the Push-to-Pass decision.
 */
export function stepRacecraft(state: RacecraftState, input: RacecraftInput): RacecraftOutput {
  const { line, dt, cars } = input;
  const own = Math.max(0, input.ownSpeedMs);
  const ownLat = input.ownLateralMeters;
  const aggression = clamp01(input.aggression);
  const risk = clamp01(input.risk);
  const racing = state.raceSeconds >= LAUNCH_HOLD_SECONDS;
  if (!state.initialized) {
    state.offset = ownLat;
    state.initialized = true;
  }
  state.cooldownSeconds = Math.max(0, state.cooldownSeconds - dt);
  if (state.cooldownSeconds === 0) state.cooldownKey = null;
  const roomLo = -line.roomMinusMeters;
  const roomHi = line.roomPlusMeters;

  const find = (key: string | null): FieldCarView | undefined =>
    key === null ? undefined : cars.find((car) => car.key === key);
  const inLaneOf = (car: FieldCarView, lateral: number): boolean =>
    car.lateralMeters === null || Math.abs(car.lateralMeters - lateral) < LANE_HALF_WIDTH_METERS;

  // A side is usable to go past `other` when, clamped to the road, it still
  // clears the car by a full side-by-side spacing and nobody else is (or is
  // about to be) sitting there.
  const sideAim = (other: FieldCarView, side: 1 | -1): number | null => {
    const otherLat = other.lateralMeters ?? 0;
    const aim = clamp(otherLat + side * PASS_LANE_METERS, roomLo, roomHi);
    if (side * (aim - otherLat) < SIDE_BY_SIDE_METERS) return null;
    for (const car of cars) {
      if (car === other || car.lateralMeters === null) continue;
      if (Math.abs(car.lateralMeters - aim) >= SIDE_BY_SIDE_METERS) continue;
      // In the way: beside me now, or a slower car up that lane that I'd
      // run into. One behind me is behind me; one pulling away is a car
      // to follow, not a wall.
      if (Math.abs(car.gapMeters) < OVERLAP_METERS) return null;
      if (car.gapMeters > 0 && car.gapMeters < other.gapMeters + OVERLAP_METERS + 6 && car.speedMs < own - 1) {
        return null;
      }
    }
    return aim;
  };
  const chooseSide = (other: FieldCarView): -1 | 0 | 1 => {
    let best: -1 | 0 | 1 = 0;
    let bestScore = -Infinity;
    for (const side of [1, -1] as const) {
      const aim = sideAim(other, side);
      if (aim === null) continue;
      let score = -0.3 * Math.abs(aim - ownLat);
      if (line.cornerSign === side && line.cornerAheadMeters < 350) score += 2;
      if (side === input.overtakeSide) score += 0.5;
      if (score > bestScore) {
        bestScore = score;
        best = side;
      }
    }
    return best;
  };
  // Out-braking: within a couple of car lengths, committed to the inside
  // of the corner being braked for - the move carries through the braking
  // zone. Between near-identical cars (the same power, the same top speed)
  // the braking zone is where the faster driver's speed actually shows.
  const diving = (gap: number): boolean =>
    gap < 10 && state.attemptSide !== 0 && state.attemptSide === line.cornerSign;
  const dropAttack = (cooldown: boolean): void => {
    if (cooldown) {
      state.cooldownKey = state.attemptKey;
      state.cooldownSeconds = RETRY_COOLDOWN_SECONDS;
    }
    state.attemptKey = null;
    state.attemptSide = 0;
    state.attemptSeconds = 0;
  };

  // Slow or stopped car in the lane ahead (a crash, a stalled start, the
  // player parked on pole): go round it from the green light, launch hold
  // or not - avoiding a wreck is not an attack.
  // At the lights every car is stationary, so "slow" means slow relative to
  // a moving car - or, once the start has had a few seconds, a car that is
  // still parked right in front of a crawling one (a queue behind a wreck
  // must not deadlock).
  const avoidRange = clamp(own * 1.5, 20, 90);
  let obstacle: FieldCarView | undefined;
  for (const car of cars) {
    if (car.lateralMeters === null) continue;
    if (car.gapMeters < -2 || car.gapMeters > avoidRange) continue;
    const slow =
      (own > 6 && car.speedMs < Math.max(3, own * 0.4)) ||
      ((own > 2 || state.raceSeconds > 1) && car.speedMs < 1 && car.gapMeters < 30);
    if (!slow) continue;
    if (!inLaneOf(car, ownLat) && !inLaneOf(car, state.offset)) continue;
    if (obstacle === undefined || car.gapMeters < obstacle.gapMeters) obstacle = car;
  }

  // Attack lifecycle: keep, switch or drop a live move...
  if (state.attemptKey !== null) {
    const target = find(state.attemptKey);
    if (!target || !racing || obstacle !== undefined) {
      dropAttack(false);
    } else {
      state.attemptSeconds += dt;
      const gap = target.gapMeters;
      const overlapped = Math.abs(gap) < OVERLAP_METERS - 0.5;
      if (gap < -(OVERLAP_METERS + 1) || gap > 40) {
        dropAttack(false);
      } else if (state.attemptSeconds > ATTACK_TIMEOUT_SECONDS) {
        dropAttack(true);
      } else if (!line.throttleZone && !overlapped && !diving(gap)) {
        // Reached the braking zone without a wheel in: tuck back in.
        dropAttack(true);
      } else if (!overlapped && state.attemptSide !== 0 && sideAim(target, state.attemptSide) === null) {
        const other = (-state.attemptSide) as -1 | 1;
        if (sideAim(target, other) !== null) state.attemptSide = other;
        else dropAttack(true);
      }
    }
  }
  // ...or start one: a moving car in the lane ahead, on a straight with road
  // left before the braking zone for this driver's appetite, either being
  // caught or (for the brave) already sitting in its tow.
  if (
    state.attemptKey === null &&
    obstacle === undefined &&
    racing &&
    line.throttleZone &&
    own >= 25 &&
    line.cornerAheadMeters >= 60 - risk * 30
  ) {
    const range = 12 + aggression * 16;
    let ahead: FieldCarView | undefined;
    for (const car of cars) {
      if (car.gapMeters < OVERLAP_METERS - 1 || car.gapMeters > range) continue;
      if (!inLaneOf(car, ownLat)) continue;
      if (ahead === undefined || car.gapMeters < ahead.gapMeters) ahead = car;
    }
    if (ahead && ahead.key !== state.cooldownKey && ahead.speedMs >= 3) {
      const closing = own - ahead.speedMs;
      if (closing >= 0.2 || (aggression >= 0.5 && ahead.gapMeters <= 18)) {
        const side = chooseSide(ahead);
        if (side !== 0) {
          state.attemptKey = ahead.key;
          state.attemptSide = side;
          state.attemptSeconds = 0;
        }
      }
    }
  }
  // ...or dive: reaching a braking zone right behind a car, with room on
  // the inside of the corner, a brave driver goes for the gap.
  if (
    state.attemptKey === null &&
    obstacle === undefined &&
    racing &&
    !line.throttleZone &&
    aggression >= 0.45 &&
    line.cornerSign !== 0 &&
    own >= 20
  ) {
    for (const car of cars) {
      if (car.gapMeters < OVERLAP_METERS - 1 || car.gapMeters > 9) continue;
      if (car.key === state.cooldownKey || car.speedMs < 3 || own - car.speedMs < 0.3) continue;
      if (car.lateralMeters !== null && Math.abs(car.lateralMeters - ownLat) > PASS_LANE_METERS) continue;
      if (sideAim(car, line.cornerSign) === null) continue;
      state.attemptKey = car.key;
      state.attemptSide = line.cornerSign;
      state.attemptSeconds = 0;
      break;
    }
  }
  const target = find(state.attemptKey);
  const attacking = target !== undefined && state.attemptSide !== 0;

  // Defence: one move toward the inside of the next corner when a quicker
  // car is lining up a run - never once it is alongside (the band would
  // forbid it anyway), never in the braking zone, never a second move.
  if (state.defendKey !== null) {
    const attacker = find(state.defendKey);
    if (!attacker || attacker.gapMeters < -25 || attacker.gapMeters > 0 || !line.throttleZone) {
      state.defendKey = null;
      state.defendSide = 0;
    }
  }
  if (
    state.defendKey === null &&
    !attacking &&
    racing &&
    aggression >= 0.3 &&
    line.throttleZone &&
    line.cornerSign !== 0 &&
    line.cornerAheadMeters >= 50 &&
    line.cornerAheadMeters <= 300
  ) {
    const insideRoom = line.cornerSign > 0 ? roomHi : -roomLo;
    const attacker =
      insideRoom >= 1
        ? cars.find(
            (car) =>
              car.lateralMeters !== null &&
              car.gapMeters <= -OVERLAP_METERS &&
              car.gapMeters >= -18 &&
              car.speedMs - own >= 0.8
          )
        : undefined;
    if (attacker) {
      state.defendKey = attacker.key;
      state.defendSide = line.cornerSign;
    }
  }

  // Blue flags: a car a lap up closing from behind gets the line.
  let lapper: FieldCarView | undefined;
  for (const car of cars) {
    if (car.rawGapMeters === undefined) continue;
    if (car.gapMeters < -60 || car.gapMeters > -OVERLAP_METERS) continue;
    if (car.rawGapMeters < input.trackLengthMeters / 2) continue;
    lapper = car;
    break;
  }

  // Where this car wants to be across the road, in priority order.
  let desired = 0;
  let obstacleAim: number | null = null;
  if (obstacle !== undefined) {
    const side = chooseSide(obstacle);
    obstacleAim = side !== 0 ? sideAim(obstacle, side) : null;
    // Nowhere to go round: stay put and let the follow cap stop the car.
    desired = obstacleAim ?? state.offset;
  } else if (attacking && target) {
    desired = (target.lateralMeters ?? 0) + state.attemptSide * PASS_LANE_METERS;
  } else if (state.defendKey !== null) {
    desired = state.defendSide * Math.min(1.6, state.defendSide > 0 ? roomHi : -roomLo);
  } else if (lapper !== undefined) {
    const side = (lapper.lateralMeters ?? 0) >= ownLat ? -1 : 1;
    desired = side * Math.min(2, side > 0 ? roomHi : -roomLo);
  }
  const free = clamp(desired, roomLo, roomHi);
  const band = lateralBand({
    ownLateralMeters: ownLat,
    cars,
    roomPlusMeters: line.roomPlusMeters,
    roomMinusMeters: line.roomMinusMeters,
  });
  const squeezed = band.lo > band.hi;
  const bounded = squeezed ? state.offset : clamp(free, band.lo, band.hi);
  // A car only moves across as fast as it rolls forward: an offset that
  // ran ahead of a stationary car would put it in lanes it isn't in.
  const rate = Math.min(
    Math.abs(bounded - free) > 0.05 ? EVASIVE_RATE_MS : LATERAL_RATE_MS,
    0.25 + 0.35 * own
  );
  // Frozen on the grid: before the lights go out every car keeps its own
  // column. Converging onto the line early put the second row in the pole
  // car's lane before anyone had moved.
  const maxStep = state.raceSeconds > 0 ? rate * dt : 0;
  state.offset += clamp(bounded - state.offset, -maxStep, maxStep);

  // Pace: slipstream and attack bonus up, then every cap down.
  let slipGap = Infinity;
  for (const car of cars) {
    if (car.gapMeters >= 0 && car.gapMeters < slipGap && inLaneOf(car, ownLat)) slipGap = car.gapMeters;
  }
  let pace =
    input.basePace *
    (1 +
      slipstreamBonus({ gapMeters: slipGap, speedMs: own, throttleZone: line.throttleZone }) +
      (attacking ? 0.02 + aggression * 0.02 : 0));
  // Sandwiched with no legal line (a hairpin two-wide, the road running out
  // on the exit): whoever is behind backs out; the car ahead keeps going.
  // Both lifting the same amount just keeps them side by side into contact.
  if (squeezed) {
    const behindSomeone = cars.some(
      (car) => car.lateralMeters !== null && car.gapMeters > 0.5 && car.gapMeters < OVERLAP_METERS
    );
    pace *= behindSomeone ? 0.8 : 0.97;
  }
  if (lapper !== undefined && line.throttleZone) pace *= 0.96;
  for (const car of cars) {
    if (car.lateralMeters === null || Math.abs(car.gapMeters) >= 3) continue;
    // Cautious drivers give room to a car fully alongside; anyone left on
    // the outside of a corner with a car on its inside concedes it.
    if (aggression < 0.35) {
      pace *= 0.97;
      break;
    }
    if (!line.throttleZone && line.curveSign !== 0 && line.curveSign * (car.lateralMeters - ownLat) > 1) {
      pace *= 0.98;
      break;
    }
  }
  // A tighter inside line through a corner needs a proportionally lower
  // speed: v ~ sqrt(r).
  if (line.impliedRadiusMeters < 300 && line.curveSign !== 0) {
    const inside = Math.max(0, state.offset * line.curveSign);
    pace *= Math.sqrt(Math.max(0.7, 1 - inside / line.impliedRadiusMeters));
  }
  let cap = Infinity;
  let blocked = false;
  const lane = state.offset;
  for (const car of cars) {
    if (car.gapMeters <= 0 || car.gapMeters > FOLLOW_SCAN_METERS) continue;
    // The lane being moved into counts for moving cars; a stationary one
    // there is the avoidance's job (it already aims round it).
    if (!inLaneOf(car, ownLat) && !(car.speedMs >= 1 && inLaneOf(car, lane))) continue;
    const isTarget = attacking && car.key === state.attemptKey;
    // Threading round a stationary car with a clear side: creep toward it
    // (fading to a stop a meter off its gearbox) instead of waiting at the
    // standoff - a car can't turn out of a lane it isn't rolling in.
    const threading = car === obstacle && obstacleAim !== null && car.speedMs < 1;
    const carCap = threading
      ? Math.max(0, Math.min(5, 0.8 * (car.gapMeters - 5.5)))
      : followSpeedCapMs(car.gapMeters, car.speedMs, followGapMeters(own, aggression, isTarget, car.speedMs));
    if (carCap < cap) {
      cap = carCap;
      blocked = car.speedMs < 4 && car.gapMeters < 15;
    }
  }
  if (obstacle !== undefined && obstacle.speedMs < 4 && !inLaneOf(obstacle, ownLat)) {
    // Threading past a stopped car: carefully, not at racing speed.
    cap = Math.min(cap, 18);
  }
  if (cap < Infinity) {
    pace = Math.min(pace, cap / Math.max(1, line.profileTargetMs));
  }
  pace = Math.max(0, pace);

  // Dump the battery only on a move that can work: a real straight ahead
  // and the target close. Spending it on every look out of a slow corner
  // left attackers with an empty battery on the next straight, where the
  // car they were chasing (banking its energy) simply drove away.
  const winnable =
    attacking &&
    line.throttleZone &&
    line.cornerAheadMeters >= 180 &&
    target !== undefined &&
    target.gapMeters <= 20;
  let gapAhead = Infinity;
  for (const car of cars) if (car.gapMeters > 0 && car.gapMeters < gapAhead) gapAhead = car.gapMeters;
  const override = overrideModeActive(gapAhead, own);
  // In the override window the energy is cheap: spend it chasing.
  const deploy =
    !input.mistakeActive &&
    shouldDeployBoost({
      boostEligible: input.boostEligible,
      batteryFraction: input.batteryFraction,
      aggression,
      attemptingLunge: winnable || (override && line.throttleZone),
    });
  // At walking pace the steering's long preview asks for only a few
  // degrees of lock; threading round a stationary car needs a real turn,
  // so the offset it pursues is stretched away from where the car is.
  let steerOffsetMeters = state.offset;
  if (obstacleAim !== null && own < 10) {
    steerOffsetMeters = ownLat + (obstacleAim - ownLat) * (1 + 3 * (1 - own / 10));
  }
  return { paceMult: pace, deploy, attempting: attacking, blocked, steerOffsetMeters, override };
}
