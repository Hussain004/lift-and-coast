// Changeable weather: a seeded, scripted timeline ("rain in 2:10") layered on
// the existing weather system. The plan only decides WHICH preset the single
// weather authority (createWeatherSystem) is heading for and when; the
// system's own smoothing still eases wetness and grip in, so nothing
// teleports and the AI keeps meeting the same grip curves it has always
// met in rain.
import type { WeatherPreset } from "./weather";

/** What a session can be set to: a fixed preset, or a scripted mix. */
export type WeatherSetting = WeatherPreset | "changeable";

export function isWeatherSetting(value: unknown): value is WeatherSetting {
  return value === "clear" || value === "cloudy" || value === "rain" || value === "changeable";
}

export function parseWeatherSetting(raw: string | null): WeatherSetting {
  return isWeatherSetting(raw) ? raw : "clear";
}

export interface WeatherChange {
  atSeconds: number;
  preset: WeatherPreset;
}

export interface WeatherPlan {
  start: WeatherPreset;
  changes: WeatherChange[];
}

/** No change is scripted sooner than this, so the opening laps are settled. */
const FIRST_CHANGE_MIN_SECONDS = 75;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A plan from a seed: it starts dry or cloudy, rain arrives 75-165 s in, and
 * after 2-3 minutes it eases back to cloudy. The same seed always gives the
 * same afternoon, so a race can be re-run and a friend can be sent the link.
 */
export function createWeatherPlan(seed: number): WeatherPlan {
  const rand = mulberry32(seed * 7919 + 13);
  const start: WeatherPreset = rand() < 0.5 ? "clear" : "cloudy";
  const rainAt = FIRST_CHANGE_MIN_SECONDS + Math.round(rand() * 90);
  const dryAt = rainAt + 120 + Math.round(rand() * 60);
  return {
    start,
    changes: [
      { atSeconds: rainAt, preset: "rain" },
      { atSeconds: dryAt, preset: "cloudy" },
    ],
  };
}

export function planPresetAt(plan: WeatherPlan, seconds: number): WeatherPreset {
  let preset = plan.start;
  for (const change of plan.changes) {
    if (seconds >= change.atSeconds) preset = change.preset;
  }
  return preset;
}

/** The next scripted change after `seconds`, or null when the plan is done. */
export function nextWeatherChange(plan: WeatherPlan, seconds: number): { inSeconds: number; preset: WeatherPreset } | null {
  for (const change of plan.changes) {
    if (change.atSeconds > seconds) return { inSeconds: change.atSeconds - seconds, preset: change.preset };
  }
  return null;
}

/** "Rain in 2:10" style label for the weather page, or null when nothing is coming. */
export function forecastLabel(next: { inSeconds: number; preset: WeatherPreset } | null): string | null {
  if (!next) return null;
  const s = Math.max(0, Math.round(next.inSeconds));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return next.preset === "rain" ? `RAIN IN ${clock}` : `${next.preset === "clear" ? "CLEARING" : "EASING"} IN ${clock}`;
}
