export interface EnergyInput {
  /** 0..1, how hard the brake is being applied this tick. */
  brakeAmount: number;
  /** Whether the player is holding the deploy (Push-to-Pass) input. */
  deployRequested: boolean;
  /** Manual Override Mode (see overrideModeActive): deploying costs less. */
  overrideActive?: boolean;
}

export interface EnergyStatus {
  /** 0..1 battery charge. */
  batteryFraction: number;
  /** True only if deploy was requested AND there was charge to use. */
  isDeploying: boolean;
  /** Multiply the normal engine force by this - 1 when not deploying. */
  engineForceMultiplier: number;
}

const HARVEST_FRACTION_PER_SECOND = 0.15;
const DEPLOY_DRAIN_FRACTION_PER_SECOND = 0.25;
// Exported so racingLine.ts's boosted speed profile (see boostedTargetSpeedMs)
// can derive its accel bonus from the same number instead of a second,
// independently-tuned constant that could drift out of sync with it.
export const DEPLOY_BOOST_MULTIPLIER = 1.6;

/**
 * Manual Override Mode, the 2026 rules' replacement for DRS: a car within
 * one second of the car ahead gets extra electrical energy. Engine force is
 * already at its hard cap while deploying (see applyCarControls), so the
 * override is energy, not power: deployment drains at 40% of the normal
 * rate, and the chasing car can deploy down a whole straight while the car
 * ahead eats into its battery. Same rule for the player and the AI.
 */
export const OVERRIDE_WINDOW_SECONDS = 1;
const OVERRIDE_DRAIN_FRACTION = 0.4;

export function overrideModeActive(gapAheadMeters: number, speedMs: number): boolean {
  return speedMs > 20 && gapAheadMeters > 0 && gapAheadMeters <= speedMs * OVERRIDE_WINDOW_SECONDS;
}

/**
 * The game's namesake mechanic: harvest energy under braking, deploy it on
 * straights for a power boost (plan section 5, "Push-to-Pass Override").
 * Energy is free to manage; racing adds Manual Override Mode below (the
 * deployment bonus when close behind an opponent).
 *
 * If deploy is requested while also braking, deploying wins for that tick
 * (no harvest) - simplest rule, and driving both at once is an unusual
 * choice a player would rarely actually make.
 */
export function createEnergySystem(initialBatteryFraction = 1) {
  let battery = Math.max(0, Math.min(1, initialBatteryFraction));

  function update(input: EnergyInput, dt: number): EnergyStatus {
    const isDeploying = input.deployRequested && battery > 0;
    if (isDeploying) {
      const drain = DEPLOY_DRAIN_FRACTION_PER_SECOND * (input.overrideActive ? OVERRIDE_DRAIN_FRACTION : 1);
      battery = Math.max(0, battery - drain * dt);
    } else if (input.brakeAmount > 0) {
      battery = Math.min(1, battery + HARVEST_FRACTION_PER_SECOND * input.brakeAmount * dt);
    }

    return {
      batteryFraction: battery,
      isDeploying,
      engineForceMultiplier: isDeploying ? DEPLOY_BOOST_MULTIPLIER : 1,
    };
  }

  return { update };
}
