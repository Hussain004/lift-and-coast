export type EnergyMode = "harvest" | "balanced" | "attack";

export interface EnergyInput {
  /** 0..1, how hard the brake is being applied this tick. */
  brakeAmount: number;
  /** Whether the player is holding the deploy (Push-to-Pass) input. */
  deployRequested: boolean;
  /** Manual Override Mode (see overrideModeActive): deploying costs less. */
  overrideActive?: boolean;
  /** Optional lap identity used to reset the per-lap deployment budget. */
  lap?: number;
  /** Prevents deployment during the grid/countdown when explicitly supplied. */
  raceStarted?: boolean;
}

export interface EnergyStatus {
  /** Current deployment strategy. */
  mode: EnergyMode;
  /** 0..1 battery charge. */
  batteryFraction: number;
  /** 0..1 deployment allowance for the current lap. */
  deploymentBudgetFraction: number;
  /** True only if deploy was requested AND there was charge to use. */
  isDeploying: boolean;
  /** Multiply the normal engine force by this - 1 when not deploying. */
  engineForceMultiplier: number;
  /** 0..1 deployment thermal load. */
  thermalFraction: number;
  /** Battery gained per second while harvesting, useful for the HUD. */
  harvestRate: number;
}

// Exported so racingLine.ts's boosted speed profile (see boostedTargetSpeedMs)
// can derive its accel bonus from the same number instead of a second,
// independently-tuned constant that could drift out of sync with it.
export const DEPLOY_BOOST_MULTIPLIER = 1.6;

const ENERGY_MODE_TUNING: Record<
  EnergyMode,
  { harvest: number; drain: number; boost: number; thermalPerSecond: number }
> = {
  harvest: { harvest: 0.23, drain: 0.12, boost: 1.35, thermalPerSecond: 0.035 },
  balanced: { harvest: 0.15, drain: 0.25, boost: DEPLOY_BOOST_MULTIPLIER, thermalPerSecond: 0.08 },
  attack: { harvest: 0.1, drain: 0.4, boost: 1.95, thermalPerSecond: 0.13 },
};

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
export function createEnergySystem(
  initialBatteryFraction = 1,
  initialMode: EnergyMode = "balanced"
) {
  let battery = Math.max(0, Math.min(1, initialBatteryFraction));
  let mode: EnergyMode = initialMode;
  let thermal = 0;
  let deploymentBudget = 1;
  let lastLap: number | null = null;

  function setMode(next: EnergyMode) {
    mode = next;
  }

  function resetDeploymentBudget() {
    deploymentBudget = 1;
  }

  function update(input: EnergyInput, dt: number): EnergyStatus {
    const safeDt = Math.max(0, dt);
    const tuning = ENERGY_MODE_TUNING[mode];
    if (input.lap !== undefined && input.lap !== lastLap) {
      resetDeploymentBudget();
      lastLap = input.lap;
    }
    const raceAllowed = input.raceStarted !== false;
    const thermalLimited = thermal >= 1;
    // Headless callers that do not model a lap retain the original battery-
    // only contract. Live cars pass lap identity and opt into the per-lap cap.
    const budgetAllowed = input.lap === undefined || deploymentBudget > 0;
    const isDeploying = input.deployRequested && raceAllowed && battery > 0 && budgetAllowed && !thermalLimited;
    let harvestRate = 0;
    if (isDeploying) {
      const drain = tuning.drain * (input.overrideActive ? OVERRIDE_DRAIN_FRACTION : 1);
      battery = Math.max(0, battery - drain * safeDt);
      deploymentBudget = Math.max(0, deploymentBudget - drain * safeDt);
      thermal = Math.min(1, thermal + tuning.thermalPerSecond * safeDt);
    } else {
      thermal = Math.max(0, thermal - 0.045 * safeDt);
      if (raceAllowed && input.brakeAmount > 0) {
        harvestRate = tuning.harvest * input.brakeAmount;
        battery = Math.min(1, battery + harvestRate * safeDt);
      }
    }
    const heatTaper = thermal > 0.75 ? Math.max(0.25, 1 - (thermal - 0.75) * 2.5) : 1;

    return {
      mode,
      batteryFraction: battery,
      deploymentBudgetFraction: deploymentBudget,
      isDeploying,
      engineForceMultiplier: isDeploying ? tuning.boost * heatTaper : 1,
      thermalFraction: thermal,
      harvestRate,
    };
  }

  function snapshot() {
    return { batteryFraction: battery, deploymentBudgetFraction: deploymentBudget, mode, thermalFraction: thermal };
  }

  return { update, setMode, resetDeploymentBudget, snapshot };
}
