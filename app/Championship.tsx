"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  computeStandings,
  createSeason,
  isSeasonComplete,
  nextRoundIndex,
  pointsForPosition,
  seasonChampion,
  weekendStage,
  type ChampionshipSeason,
} from "@/lib/race/championship";
import { clearSeason, loadSeason, saveSeason } from "@/lib/persistence/championship";
import { DEFAULT_RACE_LAPS, MAX_RIVALS, buildRaceUrl } from "@/lib/race/sessionSetup";
import { parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { useSessionSetupPrefs } from "@/lib/race/sessionSetup";
import { TRACKS, getTrackName } from "@/lib/tracks/registry";
import styles from "./page.module.css";

/**
 * Plan sections 7 and 8: Championship mode. A season is one race at each
 * registered circuit, scored with F1-style points. This panel is both the
 * season's entry point (start/reset) and its standings screen - the race
 * page writes each round's result (see recordChampionshipResult) and the
 * table here reflects it on return.
 */
export function Championship() {
  const [season, setSeason] = useState<ChampionshipSeason | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Same live roster pick as SessionSetup's Drive link - championship rounds
  // grid the same two cars.
  const { teamId, driverCode } = useRosterSelection();
  const { timeOfDay, weather } = useSessionSetupPrefs();

  useEffect(() => {
    let cancelled = false;
    loadSeason().then((saved) => {
      if (cancelled) return;
      setSeason(saved);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function startSeason() {
    const fresh = createSeason(
      TRACKS.map((track) => track.id),
      new Date().toISOString()
    );
    setSeason(fresh);
    void saveSeason(fresh);
  }

  function resetSeason() {
    setSeason(null);
    void clearSeason();
  }

  if (!loaded) {
    return (
      <div className={styles.championship}>
        <span className={styles.championshipHeading}>CHAMPIONSHIP</span>
        <p className={styles.championshipNote}>Loading season…</p>
      </div>
    );
  }

  if (!season) {
    return (
      <div className={styles.championship}>
        <span className={styles.championshipHeading}>CHAMPIONSHIP</span>
        <p className={styles.championshipNote}>
          {TRACKS.length} rounds, one at each circuit. F1-style points: 25 for the win, 18 for
          second.
        </p>
        <button
          type="button"
          className={styles.championshipButton}
          onClick={startSeason}
        >
          Start season
        </button>
      </div>
    );
  }

  const standings = computeStandings(season);
  const complete = isSeasonComplete(season);
  const next = nextRoundIndex(season);
  const champion = seasonChampion(season);

  return (
    <div className={styles.championship}>
      <span className={styles.championshipHeading}>
        CHAMPIONSHIP — ROUND {Math.min(standings.completedRounds + (complete ? 0 : 1), standings.totalRounds)}/
        {standings.totalRounds}
      </span>

      <div className={styles.championshipStandings}>
        <div className={`${styles.championshipRow} ${styles.championshipRowPlayer}`}>
          <span className={styles.championshipLabel}>YOU</span>
          <span className={styles.championshipValue}>
            {standings.playerWins} wins · {standings.playerPoints} pts
          </span>
        </div>
        <div className={styles.championshipRow}>
          <span className={styles.championshipLabel}>AI</span>
          <span className={styles.championshipValue}>
            {standings.aiWins} wins · {standings.aiPoints} pts
          </span>
        </div>
      </div>

      {complete ? (
        <p className={styles.championshipNote}>
          {champion === "player"
            ? "Season complete — you are the champion."
            : champion === "ai"
              ? "Season complete — the AI takes the title."
              : "Season complete — the title is tied."}
        </p>
      ) : (
        <p className={styles.championshipNote}>
          {getTrackName(season.rounds[next].trackId)} — practice, qualifying,
          then race {DEFAULT_RACE_LAPS} laps.
        </p>
      )}

      <ul className={styles.championshipRounds}>
        {season.rounds.map((round, i) => (
          <li
            key={round.trackId}
            className={`${styles.championshipRound} ${
              round.playerPosition !== null ? styles.championshipRoundDone : ""
            }`}
          >
            <span>{i + 1}. {getTrackName(round.trackId)}</span>
            <span>
              {round.playerPosition === null
                ? i === next
                  ? (round.qualiSpot === null ? "next" : `Q${round.qualiSpot}`)
                  : "—"
                : `P${round.playerPosition} · +${pointsForPosition(round.playerPosition)}`}
            </span>
          </li>
        ))}
      </ul>

      <div className={styles.championshipButtons}>
        {!complete && (() => {
          const round = season.rounds[next];
          const stage = weekendStage(season, next);
          // Championship weekends run the full F1 field (see MAX_RIVALS) -
          // one-off sessions pick their own count on the home panel.
          const base = {
            track: round.trackId,
            team: parseTeamId(teamId),
            driver: parseDriverCode(driverCode),
            tod: timeOfDay,
            weather,
            champ: next,
            rivals: MAX_RIVALS,
          };
          return (
            <>
              <Link
                className={styles.championshipButton}
                href={buildRaceUrl({ ...base, mode: "practice", laps: DEFAULT_RACE_LAPS })}
              >
                Practice
              </Link>
              {(stage === "qualifying" || stage === "race") && (
                <Link
                  className={styles.championshipButton}
                  href={buildRaceUrl({ ...base, mode: "qualifying", qformat: "knockout" })}
                >
                  {round.qualiSpot === null ? "Qualifying" : `Re-qualify (Q${round.qualiSpot})`}
                </Link>
              )}
              {(stage === "qualifying" || stage === "race") && (
                <Link
                  className={styles.championshipButton}
                  href={buildRaceUrl({ ...base, mode: "qualifying", qformat: "oneshot" })}
                >
                  One-shot
                </Link>
              )}
              {stage === "race" && round.qualiSpot !== null && (
                <Link
                  className={styles.championshipButton}
                  href={buildRaceUrl({
                    ...base,
                    mode: "race",
                    laps: DEFAULT_RACE_LAPS,
                    grid: round.qualiSpot,
                  })}
                >
                  Race from P{round.qualiSpot}
                </Link>
              )}
            </>
          );
        })()}
        <button type="button" className={styles.championshipButton} onClick={resetSeason}>
          {complete ? "New season" : "Reset season"}
        </button>
      </div>
    </div>
  );
}
