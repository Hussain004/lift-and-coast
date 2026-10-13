// Player options for the race HUD: its size, which panels are shown, and a
// colour-blind-safe palette. Plain CSS-level choices read once at mount, so
// nothing here is per-frame state. A hidden panel is not rendered at all and
// costs nothing.

export type HudScale = "small" | "normal" | "large";

export const HUD_SCALES: { id: HudScale; label: string; factor: number }[] = [
  { id: "small", label: "Small", factor: 0.8 },
  { id: "normal", label: "Normal", factor: 1 },
  { id: "large", label: "Large", factor: 1.2 },
];

export type HudPanel = "tower" | "map" | "mfd" | "engineerText";

export const HUD_PANELS: { id: HudPanel; label: string }[] = [
  { id: "tower", label: "Timing tower" },
  { id: "map", label: "Track map" },
  { id: "mfd", label: "Car display (speed, tyres, energy)" },
  { id: "engineerText", label: "Race engineer text" },
];

export interface HudPrefs {
  scale: HudScale;
  panels: Record<HudPanel, boolean>;
  colourBlind: boolean;
}

export const DEFAULT_HUD_PREFS: HudPrefs = {
  scale: "normal",
  panels: { tower: true, map: true, mfd: true, engineerText: true },
  colourBlind: false,
};

const KEY = "lift-and-coast.hud.v1";
const EVENT = "lift-and-coast:hud";

/** Tolerant parse: anything missing or malformed falls back to the default. */
export function parseHudPrefs(raw: string | null | undefined): HudPrefs {
  let obj: { scale?: unknown; panels?: unknown; colourBlind?: unknown } = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === "object" && parsed !== null) obj = parsed as typeof obj;
  } catch {
    // defaults
  }
  const panelsIn = (typeof obj.panels === "object" && obj.panels !== null ? obj.panels : {}) as Record<string, unknown>;
  const panels = { ...DEFAULT_HUD_PREFS.panels };
  for (const { id } of HUD_PANELS) if (typeof panelsIn[id] === "boolean") panels[id] = panelsIn[id];
  return {
    scale: HUD_SCALES.some((s) => s.id === obj.scale) ? (obj.scale as HudScale) : DEFAULT_HUD_PREFS.scale,
    panels,
    colourBlind: obj.colourBlind === true,
  };
}

/** Cached by the raw string so useSyncExternalStore gets a stable snapshot. */
let cachedRaw: string | null | undefined;
let cached: HudPrefs = DEFAULT_HUD_PREFS;

export function loadHudPrefs(): HudPrefs {
  if (typeof window === "undefined") return DEFAULT_HUD_PREFS;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    // unavailable storage: defaults
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseHudPrefs(raw);
  }
  return cached;
}

export function saveHudPrefs(prefs: HudPrefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Non-fatal: applies for this session via the event below.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeHudPrefs(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
