"use client";

import { useSyncExternalStore } from "react";
import { loadHaptics, saveHaptics, subscribeHaptics } from "@/lib/settings/hapticsPref";
import styles from "./sessionSetup.module.css";

/** Controller rumble / phone vibration on or off. */
export function HapticsSetting() {
  const on = useSyncExternalStore(subscribeHaptics, loadHaptics, () => true);
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Vibration">
      {[true, false].map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={on === value}
          onClick={() => saveHaptics(value)}
          className={on === value ? styles.presetActive : styles.preset}
        >
          {value ? "Vibration on" : "Vibration off"}
        </button>
      ))}
    </div>
  );
}
