"use client";

import { useEffect, useState } from "react";
import { MILESTONES, computeStats, earnedMilestones } from "@/lib/race/driverStats";
import type { RaceHistoryRecord } from "@/lib/race/raceHistory";
import { loadRaceHistory } from "@/lib/persistence/raceHistory";
import { getTrackName } from "@/lib/tracks/registry";
import styles from "./menu.module.css";

/** Career numbers, milestones and the last few races, all read from the race history. */
export function DriverProfile() {
  const [history, setHistory] = useState<RaceHistoryRecord[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadRaceHistory()
      .then((h) => !cancelled && setHistory(h))
      .catch(() => !cancelled && setHistory([]));
    return () => {
      cancelled = true;
    };
  }, []);
  if (history === null) return null;
  const stats = computeStats(history);
  const earned = earnedMilestones(history);
  return (
    <section className={styles.profile} aria-label="Driver profile">
      <h2 className={styles.cardTitle}>CAREER</h2>
      {history.length === 0 ? (
        <p className={styles.cardNote}>No races yet. Finish a race and your career starts here.</p>
      ) : (
        <dl className={styles.statGrid}>
          {(
            [
              ["STARTS", stats.starts],
              ["WINS", stats.wins],
              ["PODIUMS", stats.podiums],
              ["POINTS FINISHES", stats.pointsFinishes],
              ["FASTEST LAPS", stats.fastestLaps],
              ["CIRCUITS", stats.circuitsRaced],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <h2 className={styles.cardTitle} style={{ marginTop: 18 }}>
        MILESTONES · {earned.size}/{MILESTONES.length}
      </h2>
      <ul className={styles.milestones}>
        {MILESTONES.map((m) => (
          <li key={m.id} data-earned={earned.has(m.id) ? "1" : undefined}>
            <b>{m.label}</b>
            <span>{m.blurb}</span>
          </li>
        ))}
      </ul>
      {history.length > 0 && (
        <>
          <h2 className={styles.cardTitle} style={{ marginTop: 18 }}>
            RECENT RACES
          </h2>
          <ol className={styles.recent}>
            {history.slice(0, 5).map((r) => (
              <li key={r.at + r.trackId}>
                <b>{r.disqualified ? "DSQ" : `P${r.finish}`}</b>
                <span>{getTrackName(r.trackId)}</span>
                <small>
                  {r.laps} laps · {r.aiLevel}
                  {r.champRound !== null ? " · championship" : ""}
                </small>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
