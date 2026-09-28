"use client";

import { useEffect, useRef } from "react";
import type { AudioSnapshot } from "@/lib/audio/raceAudio";
import { loadHaptics, rumbleFor, subscribeHaptics } from "@/lib/settings/hapticsPref";

/** Gamepad with a rumble motor, where the browser exposes one (Chromium). */
type RumblePad = Gamepad & {
  vibrationActuator?: {
    playEffect: (type: "dual-rumble", params: { duration: number; weakMagnitude: number; strongMagnitude: number }) => Promise<unknown>;
  };
};

/**
 * The browser's answer to force feedback: kerbs, slides and impacts felt
 * through the gamepad's rumble motors, and impacts through a phone's
 * vibration. Reads the same per-frame snapshot the audio rig plays (see
 * RaceAudioRig), ~20 times a second.
 */
export function Haptics({ audioRef }: { audioRef: React.RefObject<AudioSnapshot> }) {
  const onRef = useRef(true);
  const lastImpactRef = useRef(0);
  useEffect(() => {
    onRef.current = loadHaptics();
    const unsubscribe = subscribeHaptics(() => {
      onRef.current = loadHaptics();
    });
    const id = window.setInterval(() => {
      if (!onRef.current) return;
      const snap = audioRef.current;
      let impact01 = 0;
      if (snap.impact && snap.impact.atMs !== lastImpactRef.current) {
        lastImpactRef.current = snap.impact.atMs;
        impact01 = snap.impact.strength01;
        if (impact01 > 0.2) navigator.vibrate?.(Math.round(30 + impact01 * 60));
      }
      const { weak, strong } = rumbleFor(snap.player.kerb01, snap.player.skid01, impact01);
      if (weak < 0.02 && strong < 0.02) return;
      const pad = [...(navigator.getGamepads?.() ?? [])].find((p): p is RumblePad => !!p && p.connected);
      void pad?.vibrationActuator
        ?.playEffect("dual-rumble", { duration: impact01 > 0 ? 180 : 60, weakMagnitude: weak, strongMagnitude: strong })
        .catch(() => {});
    }, 50);
    return () => {
      unsubscribe();
      window.clearInterval(id);
    };
  }, [audioRef]);
  return null;
}
