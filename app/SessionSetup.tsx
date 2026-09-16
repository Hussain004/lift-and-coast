"use client";

import Link from "next/link";
import { useState } from "react";
import {
  DEFAULT_RACE_LAPS,
  MAX_RACE_LAPS,
  MIN_RACE_LAPS,
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
} from "@/lib/race/sessionSetup";
import styles from "./sessionSetup.module.css";

// Plan section 8 (Session Setup): the lap-count slider that the race
// page's ?laps= URL param was always the stand-in for. Persists the last
// pick (plan section 10) so the next session opens the way the previous
// one left it. Difficulty/assists are deliberately absent: AI difficulty
// is blocked by the chaotic-sensitivity findings (see pathFollower.ts),
// and the assists are in-race toggles by design.
export function SessionSetup() {
  const [raceLaps, setRaceLaps] = useState(loadSessionSetupPrefs().raceLaps);

  return (
    <div className={styles.setup}>
      <div className={styles.sliderRow}>
        <span className={styles.label}>QUICK RACE — LAPS</span>
        <span className={styles.readout} aria-live="polite">
          {raceLaps}
        </span>
      </div>
      <input
        type="range"
        min={MIN_RACE_LAPS}
        max={MAX_RACE_LAPS}
        value={raceLaps}
        onChange={(e) => {
          const laps = parseInt(e.target.value, 10);
          const clamped = Number.isFinite(laps)
            ? Math.min(MAX_RACE_LAPS, Math.max(MIN_RACE_LAPS, laps))
            : DEFAULT_RACE_LAPS;
          setRaceLaps(clamped);
          saveSessionSetupPrefs({ raceLaps: clamped });
        }}
        className={styles.slider}
        aria-label="Quick Race lap count"
      />
      <div className={styles.scale}>
        <span>{MIN_RACE_LAPS}</span>
        <span>{MAX_RACE_LAPS}</span>
      </div>
      <Link href={`/race?laps=${raceLaps}`} className={styles.drive}>
        Drive
      </Link>
    </div>
  );
}