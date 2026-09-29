"use client";

import { useSyncExternalStore } from "react";
import type { DamageMode } from "@/lib/physics/damage";
import { DEFAULT_DAMAGE_MODE, loadDamageMode, saveDamageMode, subscribeDamageMode } from "@/lib/settings/damagePref";
import styles from "./sessionSetup.module.css";

const OPTIONS: { id: DamageMode; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "reduced", label: "Reduced" },
  { id: "simulation", label: "Simulation" },
];

/** Crash damage: Off, Reduced (half, no punctures) or Simulation. */
export function DamageSetting() {
  const mode = useSyncExternalStore<DamageMode>(subscribeDamageMode, loadDamageMode, () => DEFAULT_DAMAGE_MODE);
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Damage">
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={mode === option.id}
          onClick={() => saveDamageMode(option.id)}
          className={mode === option.id ? styles.presetActive : styles.preset}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
