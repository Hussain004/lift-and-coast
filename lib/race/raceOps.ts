import type { TireCompoundId } from "../physics/tireModel";
import type { DrsState } from "../physics/drs";
import type { WeatherPreset, WeatherState } from "../physics/weather";
import type { EnergyMode } from "../physics/energy";
import type { RaceControlState } from "./raceControl";
import type { ReplayState, TelemetryFrame } from "./replay";
import type { StrategyMode, StrategyState } from "./strategy";

export type WeatherHandle = ReturnType<typeof import("../physics/weather").createWeatherSystem>;
export type RaceControlHandle = ReturnType<typeof import("./raceControl").createRaceControlSystem>;

export interface RaceOpsSnapshot {
  weather: WeatherState;
  strategy: StrategyState;
  energyMode: EnergyMode;
  batteryFraction: number;
  deploymentBudgetFraction: number;
  drs: DrsState;
  raceControl: RaceControlState;
  replay: ReplayState;
  telemetry: TelemetryFrame[];
}

export type RaceOpsCommand =
  | { type: "set-weather"; preset: WeatherPreset }
  | { type: "set-ers-mode"; mode: EnergyMode }
  | { type: "set-strategy-mode"; mode: StrategyMode }
  | { type: "set-compound"; compound: TireCompoundId }
  | { type: "request-pit" }
  | { type: "cancel-pit" }
  | { type: "toggle-drs" }
  | { type: "toggle-replay" }
  | { type: "stop-replay" }
  | { type: "seek-replay"; seconds: number }
  | { type: "report-unsafe-rejoin" };
