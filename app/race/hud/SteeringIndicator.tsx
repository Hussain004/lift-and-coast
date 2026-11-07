"use client";

import { useEffect, useRef, useState } from "react";
import { getControlSettings, subscribeToControls } from "@/lib/input/keyBindings";
import type { HudSnapshot } from "@/lib/race/hud";
import { useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

/**
 * On-screen steering indicator for keyboard players learning the car (B4).
 * Shows where the current input sits between full lock and full lock
 * (-1..+1) on a bar above the centre of the screen, with a fixed centre
 * tick so "am I straight?" is answerable at a glance. Off by default;
 * opt in from the Controls settings (STEERING > On-screen steering
 * indicator). Reads only the live HUD snapshot's steer value.
 */
export function SteeringIndicator({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const [enabled, setEnabled] = useState(() => getControlSettings().steeringIndicator);
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeToControls(() => setEnabled(getControlSettings().steeringIndicator)), []);

  useHudFrame(() => {
    const steer = hudRef.current?.steer ?? 0;
    // -1..1 maps to 0..100% across the track; the centre tick is the
    // reference for "wheel straight".
    if (dotRef.current) {
      dotRef.current.style.left = `${((Math.max(-1, Math.min(1, steer)) + 1) * 50).toFixed(2)}%`;
    }
  });

  if (!enabled) return null;

  return (
    <div className={styles.steerBar} role="img" aria-label="Current steering input, left to right">
      <div className={styles.steerCenter} aria-hidden="true" />
      <div ref={dotRef} className={styles.steerDot} aria-hidden="true" />
      <span className={styles.steerEnd} style={{ left: 4 }} aria-hidden="true">
        L
      </span>
      <span className={styles.steerEnd} style={{ right: 4 }} aria-hidden="true">
        R
      </span>
    </div>
  );
}
