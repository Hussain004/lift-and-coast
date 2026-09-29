// The race engineer: radio calls derived from what the HUD already knows.
// Pure - it reads successive HudSnapshots and returns the lines to say, with
// per-topic cooldowns so the radio talks like an engineer, not a ticker.
// app/race/hud/Engineer.tsx turns the lines into banners and (optionally)
// speech.
import type { HudSnapshot } from "./hud";

export interface EngineerState {
  /** Seconds of session time seen so far (advanced by the caller's dt). */
  clock: number;
  started: boolean;
  lastPosition: number | null;
  /** Topic -> clock value it may speak again at. */
  quietUntil: Record<string, number>;
  /** Once-per-session / once-per-stint calls already made. */
  said: Set<string>;
  lastDamage: number;
  lastWeather: string;
  lastLap: number;
  lastPitStops: number;
}

export function createEngineerState(): EngineerState {
  return {
    clock: 0,
    started: false,
    lastPosition: null,
    quietUntil: {},
    said: new Set(),
    lastDamage: 1,
    lastWeather: "",
    lastLap: 1,
    lastPitStops: 0,
  };
}

function ordinalWord(p: number): string {
  return `P${p}`;
}

/** Seconds as the radio says them: "0.8", "1.4". */
function spokenGap(seconds: number): string {
  return seconds.toFixed(1);
}

/**
 * Advances the engineer by `dt` seconds against the latest snapshot and
 * returns any lines to say now (usually none). The first call after lights
 * out opens the race; everything else is gated on cooldowns.
 */
export function engineerStep(state: EngineerState, hud: HudSnapshot, dt: number): string[] {
  state.clock += dt;
  const out: string[] = [];
  const can = (topic: string, cooldown: number) => {
    if ((state.quietUntil[topic] ?? 0) > state.clock) return false;
    state.quietUntil[topic] = state.clock + cooldown;
    return true;
  };
  const once = (key: string) => {
    if (state.said.has(key)) return false;
    state.said.add(key);
    return true;
  };
  const race = hud.sessionMode === "race";

  if (hud.result) {
    if (once("result")) {
      if (hud.result.kind === "race") {
        const p = hud.result.position;
        out.push(
          p === 1
            ? "Yes! P1! You've won it! Fantastic drive."
            : p <= 3
              ? `${ordinalWord(p)}, that's a podium! Great job.`
              : p <= 10
                ? `${ordinalWord(p)}, points on the board. Good work.`
                : `That's ${ordinalWord(p)}. We'll go again next time.`
        );
      } else if (hud.result.kind === "qualifying") {
        out.push(
          hud.result.position === 1
            ? "Pole position! Mega lap."
            : `You'll start ${ordinalWord(hud.result.position)} tomorrow.`
        );
      }
    }
    return out;
  }

  // The race opens when the lap clock starts running.
  if (!state.started) {
    if (hud.lapSeconds > 0.5) {
      state.started = true;
      state.lastPosition = hud.position;
      state.lastWeather = hud.weather;
      if (race) out.push("Lights out. Keep it clean into turn one.");
    }
    return out;
  }

  // Position changes, once the first-lap shuffle has settled.
  if (race && hud.tower.length > 1 && state.lastPosition !== null && hud.position !== state.lastPosition) {
    const gained = hud.position < state.lastPosition;
    if (state.clock > 20 && can("position", 10)) {
      out.push(gained ? `Good move. ${ordinalWord(hud.position)}.` : `Lost a place, you're ${ordinalWord(hud.position)}.`);
    }
    state.lastPosition = hud.position;
  }

  // Gaps around the player from the timing tower.
  if (race && hud.tower.length > 1 && state.clock > 25) {
    const ordered = [...hud.tower].sort((a, b) => a.position - b.position);
    const i = ordered.findIndex((e) => e.isPlayer);
    const me = ordered[i];
    const behind = ordered[i + 1];
    if (me && i > 0 && me.intervalSeconds !== null && me.intervalLapsDown === 0 && me.intervalSeconds < 1 && can("attack", 45)) {
      out.push(`Gap to ${ordered[i - 1].code} is ${spokenGap(me.intervalSeconds)}. You're in overtake range.`);
    } else if (
      behind &&
      behind.intervalSeconds !== null &&
      behind.intervalLapsDown === 0 &&
      behind.intervalSeconds < 0.7 &&
      can("defend", 50)
    ) {
      out.push(`${behind.code} is right behind, ${spokenGap(behind.intervalSeconds)}. Cover the inside.`);
    }
  }

  if (race && hud.totalLaps > 1 && hud.lap === hud.totalLaps && hud.lap !== state.lastLap && once("final-lap")) {
    out.push("Final lap. Bring it home.");
  }
  if (hud.lap !== state.lastLap && hud.lastLapSeconds !== null && !race && can("laptime", 20)) {
    const m = Math.floor(hud.lastLapSeconds / 60);
    const s = (hud.lastLapSeconds - m * 60).toFixed(1);
    out.push(`Lap time ${m}:${s.padStart(4, "0")}.`);
  }
  state.lastLap = hud.lap;

  if (hud.pitStops !== state.lastPitStops) {
    state.lastPitStops = hud.pitStops;
    state.said.delete("tyres");
    state.said.delete("fuel");
    out.push("Good stop. Push now, tyres are fresh.");
  }
  if (hud.tyreWear01 > 0.75 && once("tyres")) {
    out.push("Tyres are going off. Box when you're ready, O to request.");
  }
  if (hud.fuelWarning && once("fuel")) {
    out.push("Fuel is critical. Lift and coast into the braking zones.");
  }
  if (hud.damage < state.lastDamage - 0.04) {
    if (can("damage", 15)) {
      const parts = hud.damageParts;
      const worst = (
        [
          ["front wing", parts.frontWing],
          ["rear wing", parts.rearWing],
          ["floor", parts.floor],
        ] as const
      ).reduce((a, b) => (b[1] < a[1] ? b : a));
      out.push(
        `Damage to the ${worst[0]}. About ${Math.round((1 - hud.damage) * 100)} percent grip gone, we can fix it at a stop.`
      );
    }
  }
  state.lastDamage = hud.damage;

  if (hud.trackLimitText.includes("2/3") && can("limits", 60)) {
    out.push("Careful with track limits. One more and it's a flag.");
  }
  if (race || hud.sessionMode === "practice") {
    if (hud.forecastTo === "rain" && hud.forecastInSeconds !== null) {
      if (hud.forecastInSeconds < 110 && once("rain-soon")) {
        const s = Math.round(hud.forecastInSeconds / 10) * 10;
        out.push(`Rain is forecast in about ${s} seconds. Think about inters.`);
      } else if (hud.forecastInSeconds < 35 && once("rain-imminent")) {
        out.push("Rain is very close now. Inters are the safe call.");
      }
    }
  }
  if (hud.weather !== state.lastWeather) {
    const slicks = hud.compound === "soft" || hud.compound === "medium" || hud.compound === "hard";
    if (hud.weather === "rain") {
      out.push(
        slicks
          ? "Rain is here. Grip is way down. Fit inters, press 4."
          : "Rain is here. You're on the right tyre, keep it tidy."
      );
    } else if (state.lastWeather === "rain") {
      out.push(
        slicks ? "Rain has stopped. The track will come back to you." : "Rain has stopped. The track will dry, slicks soon."
      );
    }
    state.lastWeather = hud.weather;
  }
  if (hud.clockSeconds !== null && hud.clockSeconds < 60 && hud.clockSeconds > 1 && once(`clock-${hud.phase}`)) {
    out.push("One minute left in the session. Make this lap count.");
  }
  return out;
}
