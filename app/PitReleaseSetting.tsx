"use client";

import { useSyncExternalStore } from "react";
import {
  loadPitReleaseEnabled,
  savePitReleaseEnabled,
  subscribePitReleaseEnabled,
} from "@/lib/settings/pitReleasePref";
import styles from "./sessionSetup.module.css";

/**
 * The pit-stop release mini-game on or off (see lib/race/pitRelease.ts).
 * Turning it off removes the light, the window and both the credit and the
 * penalty - the stop itself is completely unchanged, it just becomes
 * something you sit through rather than something you take part in.
 */
export function PitReleaseSetting() {
  const enabled = useSyncExternalStore(
    subscribePitReleaseEnabled,
    loadPitReleaseEnabled,
    () => true
  );
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Pit stop release game">
      {[true, false].map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={enabled === value}
          onClick={() => savePitReleaseEnabled(value)}
          className={enabled === value ? styles.presetActive : styles.preset}
        >
          {value ? "Release game on" : "Release game off"}
        </button>
      ))}
    </div>
  );
}