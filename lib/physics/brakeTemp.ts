/**
 * Brake temperature DISC METER (post owner-decision 2026-11-09, strip).
 *
 * Until now this module modelled real disc thermodynamics LINKED to the
 * car: cold-bite below ~230 C, fade ramps past ~700 C up to half of what
 * the driver had. The shipped behaviour read as "brakes got so much
 * worse" - the owner removed it. The module now exists as the meter it
 * is on the outside of the stack: the MFD shows the axle temperatures
 * climbing and cooling with the driver's braking, and the race engineer
 * will call it out. The physics of the brakes is exactly what it was
 * before A9; nothing in this file affects the car in any way.
 *
 * Design kept from the original A9 for the meter to read honestly:
 * per-wheel energy integration against actual post-solve impulse work
 * (lockup boost, so the dial earns its keep by showing asymmetry), and
 * convective cooling at a speed-dependent rate.
 */

export const BRAKE_TEMP_COLD_START_C = 55;

/** Convert a wheel's per-tick brake impulse to a heat-rate coefficient (°C per unit-force per second). */
export const BRAKE_HEAT_PER_IMPULSE = 4;

/** Convective exchange coefficient envelope, 1/s. */
export const BRAKE_AIRFLOW_BASE = 0.004;
export const BRAKE_AIRFLOW_SPEED_GAIN = 0.00008;

/** Extra heat-drain multiplier applied to a wheel parked past peak slip. */
export const BRAKE_LOCKUP_HEAT_FACTOR = 1.6;

export const AMBIENT_REFERENCE_C = 25;

export interface BrakeTempInput {
  /** Per-wheel impulse measured this tick; heat is integrated from it. */
  readonly brakeImpulsePerWheel: readonly [number, number, number, number];
  /** Per-wheel slip ratio, if known, to boost the reading on locked wheels. */
  readonly slipRatioPerWheel?: readonly [number, number, number, number];
  /**
   * The driver's applied brake command, 0..1. Heat accrues only when this is
   * non-zero, and only from impulses opposing the car's motion; drive work is
   * never counted. Propulsion impulses on the driven wheels and coasting
   * work are not charged to the discs.
   */
  readonly brake01: number;
  /** Car forward speed m/s, for the airflow envelope. */
  readonly forwardSpeedMs: number;
  readonly ambientC: number;
  readonly dt: number;
}

export interface BrakeTempSnapshot {
  /** Worst-of-axle readings, for the MFD CAR page. */
  readonly tempFrontC: number;
  readonly tempRearC: number;
  /** Per-wheel temperatures, CAR_WHEELS order. */
  readonly perWheel: readonly [number, number, number, number];
}

export interface BrakeTempModel {
  readonly tempFrontC: number;
  readonly tempRearC: number;
  readonly perWheel: readonly [number, number, number, number];
  update(input: BrakeTempInput): void;
  snapshot(): BrakeTempSnapshot;
}

/**
 * Per-wheel disc temperature integration. Player-facing by caller
 * discipline; AI and headless sims never construct this and never see
 * brake temperatures. The AI behaviour intentionally carries no brake
 * model at all.
 */
export function createBrakeTempModel(
  initialTempC: number = BRAKE_TEMP_COLD_START_C
): BrakeTempModel {
  const initial = Number.isFinite(initialTempC) ? initialTempC : BRAKE_TEMP_COLD_START_C;
  const perWheel: [number, number, number, number] = [initial, initial, initial, initial];

  function update(input: BrakeTempInput): void {
    const dt = input.dt;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const v = Math.abs(input.forwardSpeedMs);
    const airflow = BRAKE_AIRFLOW_BASE + BRAKE_AIRFLOW_SPEED_GAIN * v;
    const rollingForward = input.forwardSpeedMs >= 0;
    const pedalling = input.brake01 > 0;
    for (let i = 0; i < 4; i++) {
      const impulse = input.brakeImpulsePerWheel[i];
      // Heat source: brake work only. Aids like the sign convention of the
      // wheel impulses so the meter can tell push from holdback.
      const brakeHeatSource =
        pedalling && Number.isFinite(impulse)
          ? rollingForward
            ? Math.max(0, -impulse)
            : Math.max(0, impulse)
          : 0;
      const slipBoost =
        input.slipRatioPerWheel !== undefined && Math.abs(input.slipRatioPerWheel[i]) > 0.3
          ? BRAKE_LOCKUP_HEAT_FACTOR
          : 1;
      const heating = BRAKE_HEAT_PER_IMPULSE * brakeHeatSource * slipBoost * dt;
      const cooling = (perWheel[i] - input.ambientC) * airflow * dt;
      const next = perWheel[i] + heating - cooling;
      perWheel[i] = Number.isFinite(next) ? Math.max(-273, next) : perWheel[i];
    }
  }

  function snapshot(): BrakeTempSnapshot {
    const front = (perWheel[0] + perWheel[1]) / 2;
    const rear = (perWheel[2] + perWheel[3]) / 2;
    return {
      tempFrontC: front,
      tempRearC: rear,
      perWheel: [...perWheel] as [number, number, number, number],
    };
  }

  return {
    get tempFrontC() {
      return (perWheel[0] + perWheel[1]) / 2;
    },
    get tempRearC() {
      return (perWheel[2] + perWheel[3]) / 2;
    },
    get perWheel() {
      return [...perWheel] as [number, number, number, number];
    },
    update,
    snapshot,
  };
}
