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
import { TRACKS, parseTrackId } from "@/lib/tracks/registry";
import styles from "./sessionSetup.module.css";

// Plan section 8 (Session Setup): the lap-count slider and track picker
// that the race page's ?laps= / ?track= URL params were always the
// stand-in for. Persists the last picks (plan section 10) so the next
// session opens the way the previous one left it. Difficulty is
// deliberately absent: AI difficulty tiers are blocked by the
// chaotic-sensitivity findings (see pathFollower.ts), and the assists are
// in-race toggles by design.
export function SessionSetup() {
  const initial = loadSessionSetupPrefs();
  const [raceLaps, setRaceLaps] = useState(initial.raceLaps);
  const [trackId, setTrackId] = useState(initial.trackId);

  const persist = (laps: number, id: string) => {
    saveSessionSetupPrefs({ raceLaps: laps, trackId: id });
  };

  return (
    <div className={styles.setup}>
      <div className={styles.tracks} role="radiogroup" aria-label="Circuit">
        {TRACKS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={trackId === entry.id}
            onClick={() => {
              setTrackId(entry.id);
              persist(raceLaps, entry.id);
            }}
            className={
              trackId === entry.id ? styles.trackActive : styles.track
            }
          >
            {entry.shortName}
          </button>
        ))}
      </div>
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
          persist(clamped, trackId);
        }}
        className={styles.slider}
        aria-label="Quick Race lap count"
      />
      <div className={styles.scale}>
        <span>{MIN_RACE_LAPS}</span>
        <span>{MAX_RACE_LAPS}</span>
      </div>
      <Link
        href={`/race?laps=${raceLaps}&track=${parseTrackId(trackId)}`}
        className={styles.drive}
      >
        Drive
      </Link>
    </div>
  );
}