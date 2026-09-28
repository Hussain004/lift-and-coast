"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { formatLapTime } from "@/lib/race/lapTimer";
import { formatGap, formatRaceTime, type ClassifiedRow, type SessionResult } from "@/lib/race/hud";
import { safeHex } from "./useHudFrame";
import styles from "./hud.module.css";

function raceGap(row: ClassifiedRow, winner: ClassifiedRow): string {
  if (row.position === 1) return formatRaceTime(row.totalSeconds);
  const lapsDown = winner.laps - row.laps;
  if (lapsDown >= 1) return lapsDown === 1 ? "+1 LAP" : `+${lapsDown} LAPS`;
  if (row.totalSeconds === null || winner.totalSeconds === null) return "RUNNING";
  return formatGap(row.totalSeconds - winner.totalSeconds, 3);
}

function ordinal(n: number): string {
  const s = ["TH", "ST", "ND", "RD"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/**
 * End-of-session screen: the full classification with the player's row
 * highlighted, then the next step - continue the championship, start the
 * race from the qualifying result, or go again. Enter takes the first
 * action.
 */
export function Results({
  result,
  trackName,
  onRestart,
}: {
  result: SessionResult;
  trackName: string;
  onRestart: () => void;
}) {
  const primaryRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  const setPrimary = (el: HTMLElement | null) => {
    primaryRef.current = el;
  };

  let kicker: string;
  let headline: string;
  let sub: string;
  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (result.kind === "race") {
    const winner = result.rows[0];
    const you = result.rows.find((r) => r.isPlayer);
    kicker = result.champRound !== null ? `ROUND ${result.champRound + 1} · RACE RESULT` : "RACE RESULT";
    headline = result.disqualified ? "DSQ" : `P${result.position}`;
    sub = result.disqualified
      ? "RACE BAN · 12 LICENCE POINTS"
      : `${ordinal(result.position)} PLACE · ${result.points} PTS` +
        (result.penaltySeconds > 0 ? ` · +${result.penaltySeconds}s PENALTIES` : "") +
        (you?.fastestLap ? " · FASTEST LAP" : "");
    body = (
      <table className={styles.resultTable}>
        <thead>
          <tr>
            <th>POS</th>
            <th>DRIVER</th>
            <th>TIME / GAP</th>
            <th>BEST LAP</th>
            <th>PTS</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.code} data-you={row.isPlayer ? "1" : undefined}>
              <td className={styles.resultPos}>{row.position}</td>
              <td>
                <span className={styles.resultDriver}>
                  <i style={{ background: safeHex(row.color) }} />
                  <b>{row.code}</b>
                  <span>{row.name ?? ""}</span>
                </span>
              </td>
              <td className={styles.resultNum}>
                {raceGap(row, winner)}
                {row.penaltySeconds > 0 && <em> (+{row.penaltySeconds}s)</em>}
              </td>
              <td className={styles.resultNum} data-fastest={row.fastestLap ? "1" : undefined}>
                {formatLapTime(row.bestLapSeconds)}
              </td>
              <td className={styles.resultNum}>{row.points || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    actions =
      result.champRound !== null ? (
        <>
          <Link ref={setPrimary} className={styles.primaryButton} href="/#season">
            CONTINUE CHAMPIONSHIP
          </Link>
          <button type="button" className={styles.ghostButton} onClick={onRestart}>
            RESTART RACE
          </button>
        </>
      ) : (
        <>
          <button ref={setPrimary} type="button" className={styles.primaryButton} onClick={onRestart}>
            RACE AGAIN
          </button>
          <Link className={styles.ghostButton} href="/">
            MAIN MENU
          </Link>
        </>
      );
  } else if (result.kind === "qualifying") {
    kicker = result.champRound !== null ? `ROUND ${result.champRound + 1} · QUALIFYING` : "QUALIFYING RESULT";
    headline = `P${result.position}`;
    sub = result.playerTime === null ? "NO VALID LAP" : `YOUR LAP ${formatLapTime(result.playerTime)}`;
    const relative = result.playerTime !== null;
    body = (
      <table className={styles.resultTable}>
        <thead>
          <tr>
            <th>POS</th>
            <th>DRIVER</th>
            <th>LAP</th>
            <th>{relative ? "TO YOU" : "TO POLE"}</th>
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr key={row.code} data-you={row.isPlayer ? "1" : undefined}>
              <td className={styles.resultPos}>{row.position}</td>
              <td>
                <span className={styles.resultDriver}>
                  <i style={{ background: safeHex(row.color) }} />
                  <b>{row.code}</b>
                  <span>{row.name ?? ""}</span>
                </span>
              </td>
              <td className={styles.resultNum}>{formatLapTime(row.time)}</td>
              <td className={styles.resultNum}>{row.isPlayer ? "—" : formatGap(row.gap, 3) || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
    actions = (
      <>
        <a ref={setPrimary} className={styles.primaryButton} href={result.raceHref}>
          {result.champRound !== null ? `START ROUND ${result.champRound + 1}` : "START RACE"} FROM P{result.position}
        </a>
        <button type="button" className={styles.ghostButton} onClick={onRestart}>
          RE-RUN QUALIFYING
        </button>
        <Link className={styles.ghostButton} href="/">
          MAIN MENU
        </Link>
      </>
    );
  } else {
    kicker = "PRACTICE COMPLETE";
    headline = formatLapTime(result.bestLapSeconds);
    sub = `BEST LAP OVER ${result.laps} LAPS`;
    body = null;
    actions = (
      <>
        <button ref={setPrimary} type="button" className={styles.primaryButton} onClick={onRestart}>
          DRIVE AGAIN
        </button>
        <Link className={styles.ghostButton} href="/">
          MAIN MENU
        </Link>
      </>
    );
  }

  return (
    <div className={styles.resultsOverlay} role="dialog" aria-label={kicker}>
      <div className={styles.results}>
        <div className={styles.resultsHead}>
          <div>
            <div className={styles.resultsKicker}>
              {kicker} · {trackName}
            </div>
            <div className={styles.resultsHeadline}>{headline}</div>
            <div className={styles.resultsSub}>{sub}</div>
          </div>
          <div className={styles.chequer} aria-hidden="true" />
        </div>
        {body && <div className={styles.resultsBody}>{body}</div>}
        <div className={styles.resultsActions}>{actions}</div>
      </div>
    </div>
  );
}
