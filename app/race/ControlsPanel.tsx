"use client";

import { useState } from "react";
import styles from "./race.module.css";

// The key-binding reference, docked top-right under the minimap. Collapsed
// state persists (plan section 10: localStorage for settings) so veterans
// get their corner back and newcomers still discover the keys.
const CONTROLS_KEY = "lift-and-coast.controls.v1";

function loadCollapsed(): boolean {
  try {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(CONTROLS_KEY) === "collapsed";
  } catch {
    return false;
  }
}

const BINDINGS: [string, string][] = [
  ["WASD / ←↑↓→", "drive"],
  ["R (hold)", "rewind"],
  ["Shift (hold)", "deploy"],
  ["E", "aero"],
  ["C", "cycle cameras"],
  ["V", "orbit view"],
  ["1 / 2 / 3", "tires"],
  ["T · B", "TC · ABS"],
  ["L", "racing line"],
  ["Q / Z", "shift gears"],
  ["G", "auto-gears"],
  ["M", "mute"],
  ["K", "graphics"],
  ["F", "fps"],
  ["H", "Race Ops"],
  ["X", "overtake"],
  ["O", "pit request"],
  ["P", "pause (singleplayer)"],
  ["J", "instant replay"],
  ["I", "ERS mode"],
  ["Y", "strategy mode"],
  ["U", "weather cycle"],
];

export function ControlsPanel() {
  const [collapsed, setCollapsed] = useState<boolean>(() => loadCollapsed());
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(CONTROLS_KEY, next ? "collapsed" : "open");
    } catch {
      // Non-fatal - worst case the panel reopens next visit.
    }
  };

  return (
    <div className={styles.controlsPanel}>
      <button type="button" className={styles.controlsToggle} onClick={toggle} aria-expanded={!collapsed}>
        {collapsed ? "CONTROLS +" : "CONTROLS −"}
      </button>
      {!collapsed && (
        <dl className={styles.controlsList}>
          {BINDINGS.map(([keys, action]) => (
            <div key={keys} className={styles.controlsRow}>
              <dt>{keys}</dt>
              <dd>{action}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
