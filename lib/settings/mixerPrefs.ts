// The audio mixer: five 0-1 levels, persisted locally. Master and UI scale
// every synthesized sound, engine and effects are the two race buses, and the
// engineer level scales the radio voice. Defaults are 1 (unchanged mix).

export type MixerChannel = "master" | "engine" | "effects" | "engineer" | "ui";

export const MIXER_CHANNELS: { id: MixerChannel; label: string; blurb: string }[] = [
  { id: "master", label: "Master", blurb: "Everything" },
  { id: "engine", label: "Engines", blurb: "Your car and the rivals" },
  { id: "effects", label: "Effects", blurb: "Tyres, wind, kerbs, impacts" },
  { id: "engineer", label: "Engineer", blurb: "Radio voice" },
  { id: "ui", label: "Menu sounds", blurb: "Ticks, beeps, radio click" },
];

export type Mixer = Record<MixerChannel, number>;

export const DEFAULT_MIXER: Mixer = { master: 1, engine: 1, effects: 1, engineer: 1, ui: 1 };

const KEY = "lift-and-coast.mixer.v1";
const EVENT = "lift-and-coast:mixer";

function clamp01(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

/** Tolerant parse: unknown keys are ignored, bad or missing values take the default. */
export function parseMixer(raw: string | null | undefined): Mixer {
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (typeof parsed === "object" && parsed !== null) obj = parsed as Record<string, unknown>;
  } catch {
    // fall through to defaults
  }
  const out = { ...DEFAULT_MIXER };
  for (const { id } of MIXER_CHANNELS) out[id] = clamp01(obj[id], DEFAULT_MIXER[id]);
  return out;
}

/** Slider position to gain: squared, so the middle of the slider is roughly half as loud. */
export function levelToGain(level: number): number {
  const l = clamp01(level, 1);
  return l * l;
}

/** Cached by the raw string so useSyncExternalStore gets a stable snapshot. */
let cachedRaw: string | null | undefined;
let cached: Mixer = DEFAULT_MIXER;

export function loadMixer(): Mixer {
  if (typeof window === "undefined") return DEFAULT_MIXER;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    // unavailable storage: defaults
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cached = parseMixer(raw);
  }
  return cached;
}

export function saveMixer(mixer: Mixer): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(mixer));
  } catch {
    // Non-fatal: the change still applies this session.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeMixer(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
