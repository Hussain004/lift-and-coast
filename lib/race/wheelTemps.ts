// Per-wheel tyre temperature readout. The grip model runs on one tyre
// temperature (see strategy.ts); this spreads it over the four corners for
// the wheel display the way load moves in real driving - the outside pair
// runs hot in a corner, the fronts under braking, the rears under power -
// so it is an estimate for the driver, not an input to the physics.

/** FL, FR, RL, RR. */
export type WheelTemps = [number, number, number, number];

/** +1 right, -1 left (x sign), front/rear from z, in FL, FR, RL, RR order. */
const SIDE = [-1, 1, -1, 1] as const;
const FRONT = [1, 1, 0, 0] as const;

const CORNER_C_PER_G = 2.5;
const BRAKE_C = 3;
const POWER_C = 3;
const SETTLE_SECONDS = 5;

export function createWheelTemps(baseC = 24): WheelTemps {
  return [baseC, baseC, baseC, baseC];
}

/** `latG` is signed, positive turning left (so the right-hand tyres load up). */
export function stepWheelTemps(
  temps: WheelTemps,
  baseC: number,
  input: { latG: number; brake01: number; throttle01: number; dt: number }
): void {
  const k = 1 - Math.exp(-input.dt / SETTLE_SECONDS);
  for (let i = 0; i < 4; i++) {
    const target =
      baseC +
      SIDE[i] * input.latG * CORNER_C_PER_G +
      (FRONT[i] ? input.brake01 * BRAKE_C : input.throttle01 * POWER_C);
    temps[i] += (target - temps[i]) * k;
  }
}

/** "cool" / "ok" / "hot" against the tyre's own mean temperature. */
export function wheelHeat(tempC: number, baseC: number): "cool" | "ok" | "hot" {
  return tempC > baseC + 4 ? "hot" : tempC < baseC - 4 ? "cool" : "ok";
}
