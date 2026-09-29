"use client";

import { useSyncExternalStore } from "react";
import { subscribeToControls } from "@/lib/input/keyBindings";
import type { DamageMode } from "@/lib/physics/damage";
import {
  applyControls,
  defaultControls,
  defaultStorage,
  loadLocalControls,
  saveLocalControls,
} from "@/lib/settings/controlStorage";
import { DEFAULT_DAMAGE_MODE, loadDamageMode, saveDamageMode, subscribeDamageMode } from "@/lib/settings/damagePref";
import {
  loadRacingLineStyle,
  saveRacingLineStyle,
  subscribeRacingLineStyle,
  type RacingLineStyle,
} from "@/lib/settings/racingLinePref";
import styles from "./sessionSetup.module.css";

interface Preset {
  id: string;
  label: string;
  blurb: string;
  tc: boolean;
  abs: boolean;
  line: RacingLineStyle;
  damage: DamageMode;
}

const PRESETS: Preset[] = [
  { id: "casual", label: "Casual", blurb: "Traction control and ABS on, full racing line, no damage.", tc: true, abs: true, line: "full", damage: "off" },
  { id: "standard", label: "Standard", blurb: "Assists on, full racing line, reduced damage.", tc: true, abs: true, line: "full", damage: "reduced" },
  { id: "expert", label: "Expert", blurb: "No assists, corners-only line, full damage and punctures.", tc: false, abs: false, line: "corners", damage: "simulation" },
];

function assistsKey(): string {
  const settings = (loadLocalControls(defaultStorage()) ?? defaultControls()).settings;
  return `${settings.tractionControlDefault ? 1 : 0}${settings.absDefault ? 1 : 0}`;
}

/**
 * One-tap difficulty presets for the driving aids: they set the traction
 * control and ABS defaults, the racing line style and the damage level
 * together. Each setting is still adjustable on its own below; the preset
 * that matches shows as selected, otherwise none does (a custom mix).
 */
export function AssistPresets() {
  const assists = useSyncExternalStore(subscribeToControls, assistsKey, () => "11");
  const line = useSyncExternalStore<RacingLineStyle>(subscribeRacingLineStyle, loadRacingLineStyle, () => "full");
  const damage = useSyncExternalStore<DamageMode>(subscribeDamageMode, loadDamageMode, () => DEFAULT_DAMAGE_MODE);

  const apply = (preset: Preset) => {
    const stored = loadLocalControls(defaultStorage()) ?? defaultControls();
    const next = {
      bindings: stored.bindings,
      settings: { ...stored.settings, tractionControlDefault: preset.tc, absDefault: preset.abs },
    };
    // Persist first so the subscribers applyControls wakes read the new values.
    saveLocalControls(defaultStorage(), next);
    applyControls(next);
    saveRacingLineStyle(preset.line);
    saveDamageMode(preset.damage);
  };

  const active = PRESETS.find(
    (p) => assists === `${p.tc ? 1 : 0}${p.abs ? 1 : 0}` && line === p.line && damage === p.damage
  );
  return (
    <>
      <div className={styles.presets} role="radiogroup" aria-label="Assist preset">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={active?.id === preset.id}
            onClick={() => apply(preset)}
            className={active?.id === preset.id ? styles.presetActive : styles.preset}
          >
            {preset.label}
          </button>
        ))}
      </div>
      <p style={{ opacity: 0.7, fontSize: 13, marginTop: 8 }}>{active ? active.blurb : "Custom mix of the settings below."}</p>
    </>
  );
}
