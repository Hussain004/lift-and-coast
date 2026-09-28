"use client";

import { useSyncExternalStore } from "react";
import {
  GRAPHICS_OPTIONS,
  loadGraphicsPref,
  saveGraphicsPref,
  type GraphicsPref,
} from "@/lib/render/quality";
import styles from "./sessionSetup.module.css";

const CHANGE_EVENT = "lift-and-coast:graphics";

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * The graphics tier picker (see lib/render/quality.ts). Read through an
 * external store with a fixed server snapshot, so a saved "high" can never
 * make the server and client render different chips.
 */
export function GraphicsSetting() {
  const graphics = useSyncExternalStore<GraphicsPref>(subscribe, loadGraphicsPref, () => "auto");
  return (
    <div className={styles.presets} role="radiogroup" aria-label="Graphics quality">
      {GRAPHICS_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={graphics === option.id}
          title={option.id === "auto" ? "Detects your hardware and adapts live" : undefined}
          onClick={() => {
            saveGraphicsPref(option.id);
            window.dispatchEvent(new Event(CHANGE_EVENT));
          }}
          className={graphics === option.id ? styles.presetActive : styles.preset}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
