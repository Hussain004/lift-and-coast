"use client";

import Link from "next/link";
import { useState } from "react";
import {
  DEFAULT_RACE_LAPS,
  MAX_RACE_LAPS,
  MIN_RACE_LAPS,
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
  useSessionSetupPrefs,
  type TimeOfDay,
} from "@/lib/race/sessionSetup";
import { parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { parseTrackId } from "@/lib/tracks/registry";
import styles from "./sessionSetup.module.css";

const TIME_OF_DAY_OPTIONS: { id: TimeOfDay; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "sunset", label: "Sunset" },
  { id: "overcast", label: "Overcast" },
];

// Plan section 8 (Session Setup): the lap-count slider plus the Drive link.
// The track picker used to be a button row here; it now lives on the world
// map pins above (app/WorldMap.tsx), and this panel reads the same shared
// trackId through the session-setup change event - one picker, two readers.
// Persists the last picks (plan section 10) so the next session opens the
// way the previous one left it. Difficulty is deliberately absent: AI
// difficulty tiers are blocked by the chaotic-sensitivity findings (see
// pathFollower.ts), and the assists are in-race toggles by design.
export function SessionSetup() {
  const initial = loadSessionSetupPrefs();
  const [raceLaps, setRaceLaps] = useState(initial.raceLaps);
  const { trackId, timeOfDay } = useSessionSetupPrefs();
  // Live roster pick from the team/driver panel above - carried on the Drive
  // link so the race grid dresses both cars (see lib/race/roster.ts).
  const { teamId, driverCode } = useRosterSelection();

  const persist = (laps: number, id: string, tod: TimeOfDay) => {
    saveSessionSetupPrefs({ raceLaps: laps, trackId: id, timeOfDay: tod });
  };

  return (
    <div className={styles.setup}>
      <div className={styles.label}>LIGHT</div>
      <div className={styles.presets} role="radiogroup" aria-label="Time of day">
        {TIME_OF_DAY_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={timeOfDay === option.id}
            onClick={() => persist(raceLaps, trackId, option.id)}
            className={timeOfDay === option.id ? styles.presetActive : styles.preset}
          >
            {option.label}
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
          persist(clamped, trackId, timeOfDay);
        }}
        className={styles.slider}
        aria-label="Quick Race lap count"
      />
      <div className={styles.scale}>
        <span>{MIN_RACE_LAPS}</span>
        <span>{MAX_RACE_LAPS}</span>
      </div>
      <Link
        href={`/race?laps=${raceLaps}&track=${parseTrackId(trackId)}&team=${parseTeamId(teamId)}&driver=${parseDriverCode(driverCode)}&tod=${timeOfDay}`}
        className={styles.drive}
      >
        Drive
      </Link>
    </div>
  );
}