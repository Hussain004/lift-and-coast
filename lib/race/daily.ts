// The daily challenge: one fixed race a day, the same for everyone, derived
// from the UTC date alone (no server). Medals come from the finishing
// position, so there is no lap-time target to calibrate; completion and the
// streak are read back out of the race history (records tagged with the
// day's key).

import type { TimeOfDay } from "./sessionSetup";
import type { WeatherSetting } from "../physics/weatherForecast";
import type { RaceHistoryRecord } from "./raceHistory";

export const DAILY_LAPS = 3;
export const DAILY_RIVALS = 19;

export type Medal = "gold" | "silver" | "bronze";

export interface DailyChallenge {
  key: string;
  trackId: string;
  timeOfDay: TimeOfDay;
  weather: WeatherSetting;
  laps: number;
  rivals: number;
}

const TIMES: TimeOfDay[] = ["day", "day", "sunset", "overcast", "night"];
const WEATHER: WeatherSetting[] = ["clear", "clear", "cloudy", "rain", "changeable"];

export const DAILY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The UTC date as `YYYY-MM-DD`: the same string for everyone on a given day. */
export function dailyKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** FNV-1a: tiny, stable across engines, good enough to spread a date over a few lists. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function dailyChallenge(key: string, trackIds: readonly string[]): DailyChallenge {
  const h = hash(key);
  return {
    key,
    trackId: trackIds[h % trackIds.length],
    timeOfDay: TIMES[(h >>> 8) % TIMES.length],
    weather: WEATHER[(h >>> 16) % WEATHER.length],
    laps: DAILY_LAPS,
    rivals: DAILY_RIVALS,
  };
}

export function medalFor(finish: number, disqualified = false): Medal | null {
  if (disqualified) return null;
  if (finish <= 1) return "gold";
  if (finish <= 5) return "silver";
  if (finish <= 10) return "bronze";
  return null;
}

const RANK: Record<Medal, number> = { bronze: 1, silver: 2, gold: 3 };

export interface DailyStatus {
  /** Attempts on this day's challenge. */
  attempts: number;
  best: Medal | null;
}

export function dailyStatus(history: readonly RaceHistoryRecord[], key: string): DailyStatus {
  let attempts = 0;
  let best: Medal | null = null;
  for (const r of history) {
    if (r.daily !== key) continue;
    attempts += 1;
    const medal = medalFor(r.finish, r.disqualified);
    if (medal && (best === null || RANK[medal] > RANK[best])) best = medal;
  }
  return { attempts, best };
}

function previousDay(key: string): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return dailyKey(d);
}

/**
 * Consecutive days with a daily attempt, ending today or, if today is not
 * played yet, yesterday (so the streak does not read as broken until a whole
 * day has been missed).
 */
export function dailyStreak(history: readonly RaceHistoryRecord[], todayKey: string): number {
  // Not a date (the server render has no clock to read): no streak, and no Date maths on garbage.
  if (!DAILY_KEY.test(todayKey)) return 0;
  const played = new Set(history.filter((r) => r.daily !== undefined).map((r) => r.daily as string));
  let day = played.has(todayKey) ? todayKey : previousDay(todayKey);
  let streak = 0;
  while (played.has(day)) {
    streak += 1;
    day = previousDay(day);
  }
  return streak;
}
