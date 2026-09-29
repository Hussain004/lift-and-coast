// Plan section 5, "Collisions & damage": "impacts above a threshold reduce
// front/rear aero efficiency or induce wheel misalignment (pulls the car).
// Consequential contact without a deformation system." There are no walls
// or opponent cars to hit yet (plan section 6), so today this only
// triggers from a hard chassis-to-ground impact (e.g. landing a bad flip)
// - still a genuine "impact above a threshold", just a narrower set of
// real-world triggers than the eventual multi-car version will have.
const DAMAGE_FORCE_THRESHOLD_N = 15000;
const DAMAGE_PER_HIT_FRACTION = 0.15;
export const MIN_DAMAGE_GRIP_FRACTION = 0.6;

/**
 * Applies one hit's worth of damage to an existing grip multiplier
 * (1 = undamaged), given that contact's total force. Below-threshold
 * contacts (normal suspension loads, gentle kerb contact) don't damage the
 * car at all. Only ever multiplies below 1x on top of whatever multiplier
 * it's given, same composition pattern as every other grip scale in
 * vehicle.ts/tireModel.ts/trackLimits.ts, so it composes safely with them.
 */
export function applyImpactDamage(currentGripMultiplier: number, impactForceN: number): number {
  if (impactForceN < DAMAGE_FORCE_THRESHOLD_N) return currentGripMultiplier;
  return Math.max(MIN_DAMAGE_GRIP_FRACTION, currentGripMultiplier - DAMAGE_PER_HIT_FRACTION);
}

// ---------------------------------------------------------------------------
// Component damage (player only). A hit now breaks a specific part instead of
// a single grip number: the front wing (front-axle grip), the rear wing
// (rear-axle grip), the floor (grip and downforce everywhere) and, on the
// worst hits, a puncture (one wheel). Every effect below is a reduction of a
// term that is already <= 1, composed like every other grip scale, so nothing
// here can push the friction model past its validated envelope. The single
// legacy multiplier above (applyImpactDamage) stays for the AI and its tests.
// ---------------------------------------------------------------------------

export type DamageMode = "off" | "reduced" | "simulation";
export type HitZone = "front" | "rear" | "side" | "floor";

export interface DamageState {
  /** 1 = intact, down to MIN_PART_HEALTH. */
  frontWing: number;
  rearWing: number;
  floor: number;
  /** Punctured wheel in CAR_WHEELS order (FL, FR, RL, RR), or -1. */
  puncture: number;
}

export const MIN_PART_HEALTH = 0.25;
/** A hit this hard can cut a tyre (Simulation only). */
export const PUNCTURE_FORCE_N = 45000;
const WING_GRIP_LOSS = 0.35;
const FLOOR_GRIP_LOSS = 0.18;
const PUNCTURED_WHEEL_GRIP = 0.4;

export function createDamageState(): DamageState {
  return { frontWing: 1, rearWing: 1, floor: 1, puncture: -1 };
}

export function copyDamageState(from: DamageState, to: DamageState): DamageState {
  to.frontWing = from.frontWing;
  to.rearWing = from.rearWing;
  to.floor = from.floor;
  to.puncture = from.puncture;
  return to;
}

export function isDamaged(state: DamageState): boolean {
  return state.frontWing < 0.999 || state.rearWing < 0.999 || state.floor < 0.999 || state.puncture >= 0;
}

export function isDamageMode(value: unknown): value is DamageMode {
  return value === "off" || value === "reduced" || value === "simulation";
}

/**
 * Which part a hit belongs to, from the direction of the strongest contact
 * force on the car, in the car's own frame (unit vector: forward, right,
 * up). A force pushing the car backwards is a hit on the nose. Vertical hits
 * are the floor; otherwise the dominant axis decides between nose/tail and
 * flank.
 */
export function classifyHit(local: { forward: number; right: number; up: number }): HitZone {
  if (Math.abs(local.up) > 0.7) return "floor";
  if (Math.abs(local.forward) >= Math.abs(local.right)) return local.forward < 0 ? "front" : "rear";
  return "side";
}

/**
 * Applies one hit. `pick` is any integer that varies between hits (a hit
 * counter): it chooses which wing a side hit clips and which wheel a
 * puncture takes, keeping this function deterministic. Returns true when
 * something broke.
 */
export function applyComponentDamage(
  state: DamageState,
  zone: HitZone,
  impactForceN: number,
  mode: DamageMode,
  pick = 0
): boolean {
  if (mode === "off" || impactForceN < DAMAGE_FORCE_THRESHOLD_N) return false;
  const severity = DAMAGE_PER_HIT_FRACTION + Math.min(0.2, (impactForceN - DAMAGE_FORCE_THRESHOLD_N) / 150000);
  const hit = severity * (mode === "reduced" ? 0.5 : 1);
  const lose = (part: "frontWing" | "rearWing" | "floor", amount: number) => {
    state[part] = Math.max(MIN_PART_HEALTH, state[part] - amount);
  };
  if (zone === "front") {
    lose("frontWing", hit * 1.4);
    lose("floor", hit * 0.2);
  } else if (zone === "rear") {
    lose("rearWing", hit * 1.4);
    lose("floor", hit * 0.2);
  } else if (zone === "side") {
    lose("floor", hit * 0.6);
    lose(pick % 2 === 0 ? "frontWing" : "rearWing", hit * 0.5);
  } else {
    lose("floor", hit);
  }
  if (mode === "simulation" && impactForceN >= PUNCTURE_FORCE_N && state.puncture < 0) {
    state.puncture = ((pick % 4) + 4) % 4;
  }
  return true;
}

/** Per-wheel grip multiplier from the damage, in CAR_WHEELS order (FL, FR, RL, RR). */
export function damageWheelGrips(state: DamageState, out: number[] = [1, 1, 1, 1]): number[] {
  const floor = 1 - (1 - state.floor) * FLOOR_GRIP_LOSS;
  const front = floor * (1 - (1 - state.frontWing) * WING_GRIP_LOSS);
  const rear = floor * (1 - (1 - state.rearWing) * WING_GRIP_LOSS);
  out[0] = front;
  out[1] = front;
  out[2] = rear;
  out[3] = rear;
  if (state.puncture >= 0 && state.puncture < 4) out[state.puncture] *= PUNCTURED_WHEEL_GRIP;
  return out;
}

/** Downforce multiplier (<= 1): a broken floor loses the most, wings a bit each. */
export function damageDownforceScale(state: DamageState): number {
  return 1 - (1 - state.floor) * 0.3 - (1 - state.frontWing) * 0.12 - (1 - state.rearWing) * 0.12;
}

/** One number for HUDs, the engineer and the flashback buffer: the mean wheel grip. */
export function damageAggregate(state: DamageState): number {
  const g = damageWheelGrips(state);
  return (g[0] + g[1] + g[2] + g[3]) / 4;
}

/** Extra pit-stop time to fix what is broken (a new front wing takes longest). */
export function damageRepairSeconds(state: DamageState): number {
  return (state.frontWing < 0.8 ? 2.4 : 0) + (state.rearWing < 0.8 ? 1.4 : 0) + (state.floor < 0.7 ? 1.2 : 0);
}
