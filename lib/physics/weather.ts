export type WeatherPreset = "clear" | "cloudy" | "rain";

export interface WeatherState {
  preset: WeatherPreset;
  airTemperatureC: number;
  trackTemperatureC: number;
  /** 0 = dry, 1 = fully wet. */
  wetness: number;
  rainIntensity: number;
  visibilityMeters: number;
  gripMultiplier: number;
  dragMultiplier: number;
}

interface WeatherProfile {
  airTemperatureC: number;
  trackTemperatureC: number;
  targetWetness: number;
  rainIntensity: number;
}

export const WEATHER_PRESETS: Record<WeatherPreset, WeatherProfile> = {
  clear: { airTemperatureC: 28, trackTemperatureC: 43, targetWetness: 0, rainIntensity: 0 },
  cloudy: { airTemperatureC: 21, trackTemperatureC: 31, targetWetness: 0.08, rainIntensity: 0.05 },
  rain: { airTemperatureC: 18, trackTemperatureC: 23, targetWetness: 0.82, rainIntensity: 0.9 },
};

export function parseWeatherPreset(raw: string | null): WeatherPreset {
  return raw === "cloudy" || raw === "rain" ? raw : "clear";
}

export function isWeatherPreset(value: unknown): value is WeatherPreset {
  return value === "clear" || value === "cloudy" || value === "rain";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function approach(current: number, target: number, dt: number, timeConstantSeconds: number): number {
  if (timeConstantSeconds <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / timeConstantSeconds));
}

/**
 * The race's single weather authority. It is deliberately stateful but tiny:
 * every car, HUD, and renderer reads the same snapshot, while only one
 * ticker advances it. Wetness changes gradually so a rain preset does not
 * teleport grip when a session loads.
 */
export function createWeatherSystem(initialPreset: WeatherPreset = "clear") {
  const profile = WEATHER_PRESETS[initialPreset];
  const state: WeatherState = {
    preset: initialPreset,
    airTemperatureC: profile.airTemperatureC,
    trackTemperatureC: profile.trackTemperatureC,
    wetness: profile.targetWetness,
    rainIntensity: profile.rainIntensity,
    visibilityMeters: initialPreset === "rain" ? 420 : initialPreset === "cloudy" ? 820 : 1200,
    gripMultiplier: 1,
    dragMultiplier: 1,
  };

  function recalculate() {
    const wetness = clamp01(state.wetness);
    const rain = clamp01(state.rainIntensity);
    state.gripMultiplier = Math.max(0.58, 1 - wetness * 0.32 - rain * 0.04);
    state.dragMultiplier = 1 + wetness * 0.035 + rain * 0.045;
    state.visibilityMeters = Math.round(1200 - rain * 680 - wetness * 80);
  }

  function setPreset(preset: WeatherPreset) {
    state.preset = preset;
  }

  function update(dt: number) {
    const next = WEATHER_PRESETS[state.preset];
    const safeDt = Math.max(0, Math.min(dt, 2));
    state.wetness = approach(state.wetness, next.targetWetness, safeDt, state.preset === "rain" ? 24 : 38);
    state.rainIntensity = approach(state.rainIntensity, next.rainIntensity, safeDt, state.preset === "rain" ? 18 : 30);
    // A small deterministic breathing curve keeps the sky and tire thermal
    // model alive without introducing random per-frame physics noise.
    const phase = performanceSafeTime(state);
    state.airTemperatureC = approach(
      state.airTemperatureC,
      next.airTemperatureC + Math.sin(phase / 47) * 0.8,
      safeDt,
      55
    );
    state.trackTemperatureC = approach(
      state.trackTemperatureC,
      next.trackTemperatureC + Math.sin(phase / 31) * 1.4,
      safeDt,
      70
    );
    recalculate();
  }

  function snapshot(): WeatherState {
    return { ...state };
  }

  recalculate();
  return { state, setPreset, update, snapshot };
}

function performanceSafeTime(state: WeatherState): number {
  // State has no clock dependency by design. The tiny deterministic phase is
  // derived from temperature and wetness, which is enough for visual/tire
  // variation while keeping tests and replays deterministic.
  return state.trackTemperatureC * 10 + state.wetness * 100;
}

export function weatherLabel(preset: WeatherPreset): string {
  return preset === "rain" ? "RAIN" : preset === "cloudy" ? "CLOUDY" : "CLEAR";
}
