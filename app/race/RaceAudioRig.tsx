"use client";

import { useEffect, useRef } from "react";
import {
  createRaceAudio,
  loadMuted,
  saveMuted,
  type AudioSnapshot,
  type RaceAudioEngine,
} from "@/lib/audio/raceAudio";
import { loadMixer, subscribeMixer } from "@/lib/settings/mixerPrefs";

// Plan section 12 (Audio Design): owns the synthesized race audio engine's
// whole lifecycle. The engine is constructed on mount but the context starts
// suspended - browsers only allow audio after a user gesture - so the first
// pointer/key press resumes it, and the M key toggles the persisted mute.
// A requestAnimationFrame loop feeds both cars' latest telemetry snapshot
// (written every render frame by Car.tsx/AICar.tsx) into the synth voices,
// which smooth every parameter change internally, so the loop itself stays
// a dumb pump with no audio-rate logic.
export function RaceAudioRig({
  audioRef,
  muteRef,
}: {
  audioRef: React.RefObject<AudioSnapshot>;
  muteRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const engineRef = useRef<RaceAudioEngine | null>(null);

  useEffect(() => {
    const engine = createRaceAudio();
    engineRef.current = engine;
    if (!engine) return;
    engine.setMuted(loadMuted());
    engine.setMix(loadMixer());
    const unsubscribeMixer = subscribeMixer(() => engine.setMix(loadMixer()));
    const showMuted = () => {
      if (muteRef?.current) muteRef.current.textContent = engine.muted() ? "MUTED" : "";
    };
    showMuted();
    const unlock = () => engine.resume();
    const onKeyDown = (e: KeyboardEvent) => {
      engine.resume();
      if (e.key === "m" || e.key === "M") {
        const next = !engine.muted();
        engine.setMuted(next);
        saveMuted(next);
        showMuted();
      }
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", onKeyDown);
    let raf = 0;
    const tick = () => {
      engine.update(audioRef.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      unsubscribeMixer();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", onKeyDown);
      engine.dispose();
      engineRef.current = null;
    };
    // audioRef/muteRef are stable page-level refs - mount once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
