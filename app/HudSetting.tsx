"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_HUD_PREFS,
  HUD_PANELS,
  HUD_SCALES,
  loadHudPrefs,
  saveHudPrefs,
  subscribeHudPrefs,
} from "@/lib/settings/hudPrefs";
import styles from "./sessionSetup.module.css";

/** Race HUD options: size, which panels show, and a colour-blind-safe palette. */
export function HudSetting() {
  const prefs = useSyncExternalStore(subscribeHudPrefs, loadHudPrefs, () => DEFAULT_HUD_PREFS);
  return (
    <>
      <div className={styles.presets} role="radiogroup" aria-label="HUD size">
        {HUD_SCALES.map((scale) => (
          <button
            key={scale.id}
            type="button"
            role="radio"
            aria-checked={prefs.scale === scale.id}
            onClick={() => saveHudPrefs({ ...prefs, scale: scale.id })}
            className={prefs.scale === scale.id ? styles.presetActive : styles.preset}
          >
            {scale.label}
          </button>
        ))}
      </div>
      <div className={styles.toggles}>
        {HUD_PANELS.map((panel) => (
          <label key={panel.id} className={styles.toggle}>
            <input
              type="checkbox"
              checked={prefs.panels[panel.id]}
              onChange={(e) => saveHudPrefs({ ...prefs, panels: { ...prefs.panels, [panel.id]: e.target.checked } })}
            />
            <span>{panel.label}</span>
          </label>
        ))}
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={prefs.colourBlind}
            onChange={(e) => saveHudPrefs({ ...prefs, colourBlind: e.target.checked })}
          />
          <span>Colour-blind palette (adds a ▲ ● ▼ symbol to sector colours)</span>
        </label>
      </div>
    </>
  );
}
