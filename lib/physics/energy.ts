export interface EnergyInput {
  /** 0..1, how hard the brake is being applied this tick. */
  brakeAmount: number;
  /** Whether the player is holding the deploy (Push-to-Pass) input. */
  deployRequested: boolean;
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
const DEPLOY_BOOST_MULTIPLIER = 1.6;

/**
 * The game's namesake mechanic: harvest energy under braking, deploy it on
 * straights for a power boost (plan section 5, "Push-to-Pass Override").
 * Time trial/qualifying rules per the plan: energy is free to manage, no
 * gating - that gating (deployment bonus when close behind an opponent)
 * only matters once a race mode with AI opponents exists.
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
      battery = Math.max(0, battery - DEPLOY_DRAIN_FRACTION_PER_SECOND * dt);
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
