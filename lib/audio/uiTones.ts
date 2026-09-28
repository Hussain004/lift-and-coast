// Tiny synthesized UI sounds: menu ticks, confirms, start-light beeps, the
// radio click. One lazily-created AudioContext for all of them, no assets,
// and silent when the player has muted the game (M).
import { loadMuted } from "./raceAudio";

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** One short enveloped tone. `at` delays it, in seconds. */
export function tone(freq: number, seconds: number, gain = 0.05, type: OscillatorType = "sine", at = 0): void {
  if (loadMuted()) return;
  const c = context();
  if (!c) return;
  const start = c.currentTime + at;
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, start);
  env.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  osc.connect(env).connect(c.destination);
  osc.start(start);
  osc.stop(start + seconds + 0.02);
}

export const uiTick = () => tone(1480, 0.045, 0.025, "triangle");
export const uiConfirm = () => {
  tone(880, 0.07, 0.04, "triangle");
  tone(1320, 0.1, 0.04, "triangle", 0.06);
};
/** A start light coming on: the short, flat beep of a timing gantry. */
export const startLightBeep = () => tone(880, 0.16, 0.06, "square");
/** The engineer opening the radio: two quick tones. */
export const radioClick = () => {
  tone(1320, 0.06, 0.04, "square");
  tone(990, 0.06, 0.04, "square", 0.09);
};
