"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_SAFETY_CAR_SETTING, type SafetyCarSetting as Setting } from "@/lib/race/safetyCar";
import { loadSafetyCarSetting, saveSafetyCarSetting, subscribeSafetyCarSetting } from "@/lib/settings/safetyCarPref";
import styles from "./sessionSetup.module.css";

const OPTIONS: { id: Setting; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "rare", label: "Rare" },
  { id: "frequent", label: "Frequent" },
];

/** How often the safety car and virtual safety car come out in races of three laps or more. */
export function SafetyCarSetting() {
  const setting = useSyncExternalStore<Setting>(subscribeSafetyCarSetting, loadSafetyCarSetting, () => DEFAULT_SAFETY_CAR_SETTING);
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Safety car">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={setting === option.id}
          onClick={() => saveSafetyCarSetting(option.id)}
          className={setting === option.id ? styles.presetActive : styles.preset}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
