"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";
import { useSessionTrackId } from "@/lib/race/sessionSetup";
import { getTrackName, TRACKS } from "@/lib/tracks/registry";
import { TEAMS } from "@/lib/race/rosterData";
import { formatLapTime, type LeaderboardEntry } from "@/lib/race/leaderboard";
import {
  leaderboardIsConfigured,
  loadLeaderboardForTrack,
} from "@/lib/race/leaderboardClient";

/**
 * Circuit records: the fastest laps set on the selected circuit.
 *
 * The board is PER-CIRCUIT and follows the circuit picker above it, so
 * choosing a different track on the map re-reads the board for that track.
 *
 * Strictly best-effort. The block renders its frame immediately and fills in
 * if the board answers; if it does not - offline, unconfigured, a timeout, an
 * outage - it stays in its "checking" state and the page is otherwise
 * untouched. Nothing here can block or break the circuit browser, because
 * choosing a circuit works with no network at all.
 */

const RECORDS_SHOWN = 5;
const TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));

/** "VER" -> "MAX VERSTAPPEN" via the shipped roster, falling back to the code. */
function driverName(code: string): string {
  for (const team of TEAMS) {
    for (const driver of team.drivers) {
      if (driver.code === code) return driver.name.toUpperCase();
    }
  }
  return code.toUpperCase();
}

/**
 * Who to show for a row.
 *
 * A signed-in player's own handle wins over the derived code, because the code
 * is 2-4 characters and cannot tell two players apart - and handles are not
 * unique, so this is a display name and never treated as identity. Everything
 * else falls back to the roster lookup, which is what an anonymous row still
 * has. The handle is uppercased only because this column always has been; it is
 * typed in whatever case the player chose.
 */
function entryName(entry: LeaderboardEntry): string {
  if (entry.playerName !== null && entry.playerName.length > 0) {
    return entry.playerName.toUpperCase();
  }
  return driverName(entry.driverCode);
}

function teamName(id: string): string {
  return TEAMS.find((t) => t.id === id)?.name.toUpperCase() ?? id.toUpperCase();
}


export function TrackRecords() {
  const trackId = useSessionTrackId();
  // One piece of state, and it is the fetched result tagged with the circuit
  // it belongs to. Everything else is derived during render, which keeps the
  // effect free of synchronous state writes AND means switching circuits can
  // never leave one frame showing the previous circuit's records.
  const [loaded, setLoaded] = useState<{ trackId: string; entries: LeaderboardEntry[] } | null>(null);

  // Derived, not stored: whether this build points at a board at all.
  const unconfigured = !leaderboardIsConfigured();

  useEffect(() => {
    if (unconfigured || !TRACK_IDS.has(trackId)) return;
    let cancelled = false;
    loadLeaderboardForTrack(trackId, RECORDS_SHOWN).then((entries) => {
      if (cancelled) return;
      setLoaded({ trackId, entries });
    });
    return () => {
      cancelled = true;
    };
  }, [trackId, unconfigured]);

  const fresh = loaded !== null && loaded.trackId === trackId;
  const entries: LeaderboardEntry[] = fresh ? loaded.entries : [];
  // Still waiting for the answer that matches the circuit now selected.
  const pending = !unconfigured && !fresh;

  return (
    <div className={styles.records} aria-live="polite" data-testid="track-records">
      <div className={styles.recordsHeader}>
        <span className={styles.recordsEyebrow}>TRACK RECORDS</span>
        <span className={styles.recordsTrack}>{getTrackName(trackId)}</span>
      </div>
      {unconfigured && (
        <p className={styles.recordsNote}>Records are unavailable on this build.</p>
      )}
      {!unconfigured && pending && <p className={styles.recordsNote}>Checking the board…</p>}
      {!unconfigured && !pending && entries.length === 0 && (
        <p className={styles.recordsNote}>
          Nobody has set a lap here yet. Be the first.
        </p>
      )}
      {entries.length > 0 && (
        <ol className={styles.recordsList}>
          {entries.map((entry, index) => (
            <li
              key={`${entry.createdAt}-${entry.userId ?? entry.driverCode}-${entry.lapMs}`}
              className={styles.recordsRow}
              data-podium={index < 3 ? "yes" : "no"}
            >
              <span className={styles.recordsPos}>{index + 1}</span>
              <span className={styles.recordsTime}>{formatLapTime(entry.lapMs) ?? "--"}</span>
              <span className={styles.recordsDriver}>{entryName(entry)}</span>
              <span className={styles.recordsTeam}>{teamName(entry.teamId)}</span>
              <span className={styles.recordsCompound}>{entry.compound.toUpperCase()}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
