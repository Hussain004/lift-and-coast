"use client";

import {
  TEAMS,
  resolveRosterSelection,
  saveRosterPrefs,
  useRosterSelection,
} from "@/lib/race/roster";
import type { CSSProperties, MouseEvent } from "react";
import styles from "./teamSetup.module.css";

// Pointer-tracked card tilt: writes rotation straight into CSS vars so the
// card follows the cursor with no React state churn.
function tiltProps(color: string) {
  return {
    style: { "--team": color } as CSSProperties,
    onMouseMove: (e: MouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      e.currentTarget.style.setProperty("--ry", `${(px * 10).toFixed(2)}deg`);
      e.currentTarget.style.setProperty("--rx", `${(-py * 10).toFixed(2)}deg`);
    },
    onMouseLeave: (e: MouseEvent<HTMLButtonElement>) => {
      e.currentTarget.style.removeProperty("--rx");
      e.currentTarget.style.removeProperty("--ry");
    },
  };
}

// Plan section 8 (Team Select, Driver Select): the roster half of the home
// screen. Picking a team paints your car and picks your teammate-opponent
// (see lib/race/roster.ts) - and deliberately nothing else: no pace stats,
// per the blocked-difficulty decision documented there and in
// app/SessionSetup.tsx. Persists like the session setup so the next visit
// opens on the same garage.
export function TeamSetup() {
  const { teamId, driverCode } = useRosterSelection();
  const { team, driver, teammate } = resolveRosterSelection(teamId, driverCode);

  return (
    <div className={styles.setup}>
      <div className={styles.label}>TEAM</div>
      <div className={styles.teams} role="radiogroup" aria-label="Team">
        {TEAMS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={teamId === entry.id}
            onClick={() =>
              saveRosterPrefs({ teamId: entry.id, driverCode: entry.drivers[0].code })
            }
            className={teamId === entry.id ? styles.teamActive : styles.team}
            {...tiltProps(entry.primaryColor)}
          >
            <span
              className={styles.swatch}
              style={{ background: entry.primaryColor }}
              aria-hidden="true"
            />
            {entry.name}
          </button>
        ))}
      </div>
      <div className={styles.label}>DRIVER</div>
      <div className={styles.drivers} role="radiogroup" aria-label="Driver">
        {team.drivers.map((driver) => (
          <button
            key={driver.code}
            type="button"
            role="radio"
            aria-checked={driverCode === driver.code}
            onClick={() => saveRosterPrefs({ teamId: team.id, driverCode: driver.code })}
            className={driverCode === driver.code ? styles.driverActive : styles.driver}
          >
            <span
              className={styles.helmet}
              style={{
                background: `linear-gradient(135deg, ${driver.helmet} 55%, ${driver.visor} 55%)`,
              }}
              aria-hidden="true"
            />
            <span className={styles.number}>{driver.number}</span>
            <span className={styles.code}>{driver.code}</span>
            <span className={styles.name}>{driver.name}</span>
          </button>
        ))}
      </div>
      <div className={styles.teammate}>
        {driver.name} vs teammate {teammate.name} ({teammate.code})
      </div>
    </div>
  );
}
