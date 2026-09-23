import {
  TIRE_COMPOUNDS,
  computeCompoundGripMultiplier,
  type TireCompoundId,
} from "../physics/tireModel";

export type StrategyMode = "push" | "balanced" | "save";
export type PitPhase = "none" | "requested" | "service";

export interface StrategyState {
  mode: StrategyMode;
  compound: TireCompoundId;
  fuelKg: number;
  fuelCapacityKg: number;
  tireAgeMeters: number;
  tireTemperatureC: number;
  blanketTemperatureC: number;
  blanketFitted: boolean;
  pitPhase: PitPhase;
  pitProgress: number;
  pitStops: number;
  pitWindow: boolean;
  lastPitLap: number | null;
  engineMultiplier: number;
  paceMultiplier: number;
  compoundGripMultiplier: number;
  fuelWarning: boolean;
}

export interface StrategyOptions {
  mode?: StrategyMode;
  compound?: TireCompoundId;
  fuelKg?: number;
  fuelCapacityKg?: number;
  startingBlanketTemperatureC?: number;
}

export interface StrategyUpdate {
  dt: number;
  speedMs: number;
  throttle: number;
  brake: number;
  progressMeters: number;
  trackLengthMeters: number;
  lap: number;
  racing: boolean;
  /** Signed distance from the racing centerline, used to find the marked box. */
  lateralMeters?: number;
  trackHalfWidthMeters?: number;
  airTemperatureC?: number;
  trackTemperatureC?: number;
}

export const PIT_SERVICE_SECONDS = 3.2;
export const PIT_WINDOW_METERS = 120;
const FUEL_BURN_IDLE_KG_PER_SECOND = 0.0007;
const FUEL_BURN_THROTTLE_KG_PER_SECOND = 0.08;
const LOW_FUEL_WARNING_FRACTION = 0.2;
const PIT_STOP_FUEL_REFILL_KG = 100;
const TIRE_AMBIENT_C = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pitWindowFor(
  progressMeters: number,
  trackLengthMeters: number,
  lateralMeters?: number,
  trackHalfWidthMeters?: number
): boolean {
  const progress = ((progressMeters % trackLengthMeters) + trackLengthMeters) % trackLengthMeters;
  const nearLine = progress <= PIT_WINDOW_METERS || progress >= trackLengthMeters - PIT_WINDOW_METERS;
  if (!nearLine || lateralMeters === undefined || trackHalfWidthMeters === undefined) return nearLine;
  return Math.abs(lateralMeters) >= trackHalfWidthMeters * 0.28;
}

/**
 * Player/AI race strategy. It owns fuel, tire life, compound choice, pit
 * requests, and blanket warm-up. The module never teleports a car or changes
 * the track: a stop only services when the car is stopped in the virtual pit
 * window, which keeps the strategy system honest and headless-testable.
 */
export function createStrategySystem(options: StrategyOptions = {}) {
  const capacity = Math.max(1, options.fuelCapacityKg ?? PIT_STOP_FUEL_REFILL_KG);
  const state: StrategyState = {
    mode: options.mode ?? "balanced",
    compound: options.compound ?? "medium",
    fuelKg: clamp(options.fuelKg ?? Math.min(capacity, 70), 0, capacity),
    fuelCapacityKg: capacity,
    tireAgeMeters: 0,
    tireTemperatureC: TIRE_AMBIENT_C,
    blanketTemperatureC: options.startingBlanketTemperatureC ?? TIRE_AMBIENT_C,
    blanketFitted: (options.startingBlanketTemperatureC ?? TIRE_AMBIENT_C) > TIRE_AMBIENT_C,
    pitPhase: "none",
    pitProgress: 0,
    pitStops: 0,
    pitWindow: true,
    lastPitLap: null,
    engineMultiplier: 1,
    paceMultiplier: 1,
    compoundGripMultiplier: 1,
    fuelWarning: false,
  };

  function recalculate() {
    const wearGrip = computeCompoundGripMultiplier(TIRE_COMPOUNDS[state.compound], state.tireAgeMeters);
    // Tires are fastest in their working window. This multiplier remains at
    // or below 1x so it can safely share the existing friction safety cap.
    const thermalGrip = clamp(0.86 + (state.tireTemperatureC - 10) / 180, 0.86, 1);
    state.compoundGripMultiplier = Math.min(1, wearGrip * thermalGrip);
    const fuelFraction = state.fuelKg / state.fuelCapacityKg;
    state.engineMultiplier = fuelFraction <= 0 ? 0.18 : fuelFraction < 0.06 ? 0.45 : 1;
    state.paceMultiplier = state.mode === "save" ? 0.985 : state.mode === "push" ? 1.015 : 1;
    state.fuelWarning = fuelFraction <= LOW_FUEL_WARNING_FRACTION;
  }

  function setMode(mode: StrategyMode) {
    state.mode = mode;
    recalculate();
  }

  function setCompound(compound: TireCompoundId) {
    if (state.pitPhase === "service") return;
    if (state.compound !== compound) state.tireAgeMeters = 0;
    state.compound = compound;
    recalculate();
  }

  function requestPit() {
    if (state.pitPhase === "service") return;
    state.pitPhase = "requested";
  }

  function cancelPit() {
    if (state.pitPhase === "requested") state.pitPhase = "none";
  }

  function update(input: StrategyUpdate): StrategyState {
    const dt = Math.max(0, input.dt);
    state.pitWindow = pitWindowFor(
      input.progressMeters,
      Math.max(1, input.trackLengthMeters),
      input.lateralMeters,
      input.trackHalfWidthMeters
    );
    const speed = Math.abs(input.speedMs);
    const throttle = clamp(input.throttle, 0, 1);
    const brake = clamp(input.brake, 0, 1);

    if (input.racing) {
      const modeBurnFactor = state.mode === "save" ? 0.82 : state.mode === "push" ? 1.18 : 1;
      state.fuelKg = Math.max(
        0,
        state.fuelKg -
          (FUEL_BURN_IDLE_KG_PER_SECOND +
            FUEL_BURN_THROTTLE_KG_PER_SECOND * throttle * (0.35 + speed / 60)) *
            modeBurnFactor *
            dt
      );
      state.tireAgeMeters += speed * dt;
      const ambient = (input.airTemperatureC ?? TIRE_AMBIENT_C) * 0.35 + (input.trackTemperatureC ?? TIRE_AMBIENT_C) * 0.65;
      if (state.blanketFitted && speed < 1) {
        state.tireTemperatureC += (state.blanketTemperatureC - state.tireTemperatureC) * (1 - Math.exp(-dt / 12));
      } else {
        const heatTarget = ambient + Math.min(46, speed * 0.34 + throttle * 22 + brake * 5);
        state.tireTemperatureC += (heatTarget - state.tireTemperatureC) * (1 - Math.exp(-dt / 18));
        if (state.blanketFitted) {
          state.blanketTemperatureC += (TIRE_AMBIENT_C - state.blanketTemperatureC) * (1 - Math.exp(-dt / 35));
          if (state.blanketTemperatureC < 32) state.blanketFitted = false;
        }
      }
    }

    if (state.pitPhase === "requested" && state.pitWindow && speed < 1.5) {
      state.pitPhase = "service";
      state.pitProgress = 0;
    }
    if (state.pitPhase === "service") {
      state.pitProgress = clamp(state.pitProgress + dt / PIT_SERVICE_SECONDS, 0, 1);
      if (state.pitProgress >= 1) {
        state.pitPhase = "none";
        state.pitProgress = 0;
        state.pitStops += 1;
        state.lastPitLap = input.lap;
        state.fuelKg = Math.min(state.fuelCapacityKg, state.fuelKg + PIT_STOP_FUEL_REFILL_KG);
        state.tireAgeMeters = 0;
        state.tireTemperatureC = TIRE_AMBIENT_C;
        state.blanketTemperatureC = 70;
        state.blanketFitted = true;
      }
    }

    recalculate();
    return { ...state };
  }

  function snapshot(): StrategyState {
    return { ...state };
  }

  recalculate();
  return { state, setMode, setCompound, requestPit, cancelPit, update, snapshot };
}

/** Human-readable pit/strategy line used by the race-ops panel. */
export function strategySummary(state: StrategyState): string {
  const fuel = Math.round((state.fuelKg / state.fuelCapacityKg) * 100);
  const tire = Math.round(state.compoundGripMultiplier * 100);
  const pit = state.pitPhase === "service" ? `PIT ${Math.round(state.pitProgress * 100)}%` : state.pitPhase === "requested" ? "PIT REQUESTED" : state.pitWindow ? "PIT WINDOW" : `${state.compound.toUpperCase()} ${tire}%`;
  return `${state.mode.toUpperCase()} · FUEL ${fuel}% (${state.fuelKg.toFixed(1)}kg) · ${pit}`;
}
