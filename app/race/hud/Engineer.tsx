"use client";

import { useRef } from "react";
import { createEngineerState, engineerStep } from "@/lib/race/engineer";
import { pushHudEvent, type HudSnapshot } from "@/lib/race/hud";
import { loadMuted } from "@/lib/audio/raceAudio";
import { radioClick } from "@/lib/audio/uiTones";
import { loadEngineerMode } from "@/lib/settings/engineerVoice";
import { useHudFrame } from "./useHudFrame";

const HZ = 4;

function speak(text: string) {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth) return;
  // Never let the radio fall behind the race: drop a line rather than queue it.
  if (synth.speaking || synth.pending) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.08;
  u.pitch = 0.9;
  u.volume = 0.9;
  synth.speak(u);
}

/**
 * The race engineer on the radio (see lib/race/engineer.ts): reads the HUD
 * snapshot a few times a second and turns its calls into radio banners and,
 * if the player chose it and audio is not muted, speech.
 */
export function Engineer({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const stateRef = useRef(createEngineerState());
  const lastRef = useRef<number | null>(null);
  useHudFrame((now) => {
    const dt = lastRef.current === null ? 0 : Math.min(1, (now - lastRef.current) / 1000);
    lastRef.current = now;
    const mode = loadEngineerMode();
    if (mode === "off") return;
    const hud = hudRef.current;
    const lines = engineerStep(stateRef.current, hud, dt);
    if (lines.length === 0) return;
    const voice = mode === "voice" && !loadMuted();
    for (const line of lines) {
      pushHudEvent(hud, "radio", line, undefined, 4.5);
    }
    if (voice) {
      radioClick();
      speak(lines[0]);
    }
  }, HZ);
  return null;
}
