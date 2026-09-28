"use client";

import { useSyncExternalStore } from "react";
import {
  ENGINEER_MODES,
  loadEngineerMode,
  saveEngineerMode,
  subscribeEngineerMode,
  type EngineerMode,
} from "@/lib/settings/engineerVoice";
import styles from "./sessionSetup.module.css";

/** Race engineer: voice + text, text only, or off. */
export function EngineerSetting() {
  const mode = useSyncExternalStore<EngineerMode>(subscribeEngineerMode, loadEngineerMode, () => "text");
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Race engineer">
      {ENGINEER_MODES.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={mode === option.id}
          onClick={() => saveEngineerMode(option.id)}
          className={mode === option.id ? styles.presetActive : styles.preset}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
