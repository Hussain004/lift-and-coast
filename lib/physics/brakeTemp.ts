/**
 * Brake temperature and fade (IMPROVEMENTS.md finding A9).
 *
 * Until now brakes never knew they were doing work: 25 N·m per wheel at
 * full pressure, indefinitely, with no temperature, no cold bite on an
 * out-lap and no fade to report the infamous wall at the end of a stint of
 * repeated hard stops. This module is the honest book for all three, front
 * and rear axles independently, and the same per-wheel effectiveness values
 * are consumable by the control path as a pure multiplier (same pattern as
 * the ABS pressure multiplier):
 *
 * - Heating: brake torque does work on the contact patch, E = F x v_slip.
 *   Energy lands per wheel on every tick it brakes, scaled by how far off
 *   peak the tyre is (a locked wheel dissipates the whole motion, a freely
 *   rolling wedge dissipates none). Lockups count 1.6x as fast, per
 *   IMPROVEMENTS.md ("lockups raise temp faster").
 * - Cooling: convective exchange with the ambient, faster at speed, the
 *   same exponential shape the tyre blanket model uses.
 * - Fade: past BRAKE_FADE_START_C effectiveness ramps to
 *   BRAKE_FADE_MIN_EFFECT at BRAKE_FADE_END_C. Independent of the anti-flip
 *   application ramp, which keeps its own validated role.
 * - Cold bite: below BRAKE_COLD_FULL_C effectiveness ramps from
 *   BRAKE_COLD_MIN_EFFECT at BRAKE_COLD_START_C up to 1.0, so a fresh
 *   out-lap has a pericardioally-psychic bite but never a wall.
 *
 * Player-only by caller discipline, like the other assists; AI and the
 * headless harness never consume the effectiveness (no brake temps for them
 * at all, let alone degraded braking).
 */

export const BRAKE_TEMP_COLD_START_C = 55;
export const BRAKE_COLD_FULL_C = 230;
export const BRAKE_COLD_MIN_EFFECT = 0.78;

export const BRAKE_FADE_START_C = 700;
export const BRAKE_FADE_END_C = 1000;
export const BRAKE_FADE_MIN_EFFECT = 0.5;

/** Convert a wheel's per-tick brake impulse to a heat-rate coefficient (°C per unit-force per second). */
export const BRAKE_HEAT_PER_IMPULSE = 4;

/** Convective exchange coefficient envelope, 1/s. */
export const BRAKE_AIRFLOW_BASE = 0.004;
export const BRAKE_AIRFLOW_SPEED_GAIN = 0.00008;

/** Extra heat-drain multiplier applied to a wheel parked past peak slip. */
export const BRAKE_LOCKUP_HEAT_FACTOR = 1.6;

export const AMBIENT_REFERENCE_C = 25;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Multiplier on brake torque, in [BRAKE_FADE_MIN_EFFECT .. 1]. */
export function brakeEffectivenessForTemp(tempC: number): number {
  if (!Number.isFinite(tempC)) return 1;
  if (tempC < BRAKE_COLD_FULL_C) {
    const t = clamp01((tempC - BRAKE_TEMP_COLD_START_C) / (BRAKE_COLD_FULL_C - BRAKE_TEMP_COLD_START_C));
    return BRAKE_COLD_MIN_EFFECT + (1 - BRAKE_COLD_MIN_EFFECT) * t;
  }
  if (tempC > BRAKE_FADE_START_C) {
    const t = clamp01((tempC - BRAKE_FADE_START_C) / (BRAKE_FADE_END_C - BRAKE_FADE_START_C));
    return 1 - (1 - BRAKE_FADE_MIN_EFFECT) * t;
  }
  return 1;
}

/**
 * Fade severity of the brake at tempC, 0 = healthy .. 1 = fully faded.
 * Cold-bite deficits are deliberately NOT folded in here: fade is the
 * hot-side problem; a cold disc that underperforms is exposed through
 * brakeEffectivenessForTemp directly.
 */
export function brakeFadeForTemp(tempC: number): number {
  if (!Number.isFinite(tempC) || tempC <= BRAKE_FADE_START_C) return 0;
  return clamp01((tempC - BRAKE_FADE_START_C) / (BRAKE_FADE_END_C - BRAKE_FADE_START_C));
}

export interface BrakeTempInput {
  /** Per-wheel |impulse| measured this tick; heat is integrated per impulse. */
  readonly brakeImpulsePerWheel: readonly [number, number, number, number];
  /** Per-wheel |slip velocity| the brake worked against this tick (speed-drop at the patch). */
  readonly slipVelocityPerWheel?: readonly [number, number, number, number];
  /** Per-wheel slip ratio, if known, to boost heat on locked wheels. */
  readonly slipRatioPerWheel?: readonly [number, number, number, number];
  /** Car forward speed m/s, for the airflow envelope. */
  readonly forwardSpeedMs: number;
  readonly ambientC: number;
  readonly dt: number;
}

export interface BrakeTempModel {
  /** Per-axle temperatures: [front pair mean, rear pair mean]. */
  readonly tempFrontC: number;
  readonly tempRearC: number;
  /** Per-wheel temperatures, CAR_WHEELS order. */
  readonly perWheel: readonly [number, number, number, number];
  /** Current effectiveness per wheel, to be offered as the control multiplier. */
  readonly effectiveness: readonly [number, number, number, number];
  /** 0 healthy .. 1 fully faded (worst axle). */
  readonly fade01: number;
  update(input: BrakeTempInput): void;
  snapshot(): BrakeTempSnapshot;
}

export interface BrakeTempSnapshot {
  readonly tempFrontC: number;
  readonly tempRearC: number;
  readonly perWheel: readonly [number, number, number, number];
  readonly effectiveness: readonly [number, number, number, number];
  readonly fade01: number;
}

export function createBrakeTempModel(
  initialTempC: number = BRAKE_TEMP_COLD_START_C
): BrakeTempModel {
  const initial = Number.isFinite(initialTempC) ? initialTempC : BRAKE_TEMP_COLD_START_C;
  const perWheel: [number, number, number, number] = [initial, initial, initial, initial];

  function effectivenessOf(tempC: number): number {
    return brakeEffectivenessForTemp(tempC);
  }

  function fadeOf(tempC: number): number {
    return brakeFadeForTemp(tempC);
  }

  function update(input: BrakeTempInput): void {
    const dt = input.dt;
    if (!Number.isFinite(dt) || dt <= 0) return;
    const v = Math.abs(input.forwardSpeedMs);
    const airflow = BRAKE_AIRFLOW_BASE + BRAKE_AIRFLOW_SPEED_GAIN * v;
    for (let i = 0; i < 4; i++) {
      const impulse = Math.abs(input.brakeImpulsePerWheel[i]);
      const slipBoost =
        input.slipRatioPerWheel !== undefined && Math.abs(input.slipRatioPerWheel[i]) > 0.3
          ? BRAKE_LOCKUP_HEAT_FACTOR
          : 1;
      const heating = BRAKE_HEAT_PER_IMPULSE * impulse * slipBoost * dt;
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
      effectiveness: [
        effectivenessOf(perWheel[0]),
        effectivenessOf(perWheel[1]),
        effectivenessOf(perWheel[2]),
        effectivenessOf(perWheel[3]),
      ],
      fade01: Math.max(fadeOf(front), fadeOf(rear)),
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
    get effectiveness() {
      return [
        effectivenessOf(perWheel[0]),
        effectivenessOf(perWheel[1]),
        effectivenessOf(perWheel[2]),
        effectivenessOf(perWheel[3]),
      ] as [number, number, number, number];
    },
    get fade01() {
      return Math.max(
        fadeOf((perWheel[0] + perWheel[1]) / 2),
        fadeOf((perWheel[2] + perWheel[3]) / 2)
      );
    },
    update,
    snapshot,
  };
}
