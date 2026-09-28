"use client";

import { useSyncExternalStore } from "react";
import { loadMuted, saveMuted } from "@/lib/audio/raceAudio";
import styles from "./sessionSetup.module.css";

const EVENT = "lift-and-coast:audio";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The game's master mute - the same setting M toggles in a race. */
export function AudioSetting() {
  const muted = useSyncExternalStore(subscribe, () => loadMuted(), () => false);
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Sound">
      {[false, true].map((value) => (
        <button
          key={String(value)}
          type="button"
          role="radio"
          aria-checked={muted === value}
          onClick={() => {
            saveMuted(value);
            window.dispatchEvent(new Event(EVENT));
          }}
          className={muted === value ? styles.presetActive : styles.preset}
        >
          {value ? "Sound off" : "Sound on"}
        </button>
      ))}
    </div>
  );
}
