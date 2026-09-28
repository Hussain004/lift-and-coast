"use client";

import { useRef } from "react";
import { createEngineerState, engineerStep } from "@/lib/race/engineer";
import { pushHudEvent, type HudSnapshot } from "@/lib/race/hud";
import { loadMuted } from "@/lib/audio/raceAudio";
import { loadEngineerMode } from "@/lib/settings/engineerVoice";
import { useHudFrame } from "./useHudFrame";

const HZ = 4;

/** Two short tones, the radio opening - synthesized, no asset. */
function radioClick(ctxRef: React.RefObject<AudioContext | null>) {
  try {
    const ctx = (ctxRef.current ??= new AudioContext());
    const now = ctx.currentTime;
    [0, 0.09].forEach((at, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = i === 0 ? 1320 : 990;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.05, now + at + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.07);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.08);
    });
  } catch {
    // No audio available - the text banner still carries the message.
  }
}

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
  const ctxRef = useRef<AudioContext | null>(null);
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
      radioClick(ctxRef);
      speak(lines[0]);
    }
  }, HZ);
  return null;
}
