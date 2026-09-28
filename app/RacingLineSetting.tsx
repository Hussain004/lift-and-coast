"use client";

import { useSyncExternalStore } from "react";
import {
  loadRacingLineStyle,
  saveRacingLineStyle,
  subscribeRacingLineStyle,
  type RacingLineStyle,
} from "@/lib/settings/racingLinePref";
import styles from "./sessionSetup.module.css";

const OPTIONS: { id: RacingLineStyle; label: string }[] = [
  { id: "full", label: "Full line" },
  { id: "corners", label: "Corners only" },
];

/** Racing line style; L still shows or hides it in a race. */
export function RacingLineSetting() {
  const style = useSyncExternalStore<RacingLineStyle>(subscribeRacingLineStyle, loadRacingLineStyle, () => "full");
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Racing line">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={style === option.id}
          onClick={() => saveRacingLineStyle(option.id)}
          className={style === option.id ? styles.presetActive : styles.preset}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
