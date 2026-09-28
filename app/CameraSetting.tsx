"use client";

import { useSyncExternalStore } from "react";
import { loadCameraShake, saveCameraShake, subscribeCameraShake } from "@/lib/settings/cameraPrefs";
import styles from "./sessionSetup.module.css";

/** Camera shake on/off (kerbs and high-speed buzz). */
export function CameraSetting() {
  const on = useSyncExternalStore(subscribeCameraShake, loadCameraShake, () => true);
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Camera shake">
      {[true, false].map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={on === value}
          onClick={() => saveCameraShake(value)}
          className={on === value ? styles.presetActive : styles.preset}
        >
          {value ? "Shake on" : "Shake off"}
        </button>
      ))}
    </div>
  );
}
