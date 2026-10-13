"use client";

import { useState } from "react";
import { formatLapTime } from "@/lib/race/lapTimer";
import type { Debrief as DebriefData } from "@/lib/race/raceLog";
import type { ClassifiedRow } from "@/lib/race/hud";
import { safeHex } from "./useHudFrame";
import styles from "./hud.module.css";

type Tab = "classification" | "positions" | "laps" | "stints";

const TABS: { id: Tab; label: string }[] = [
  { id: "classification", label: "Classification" },
  { id: "positions", label: "Lap chart" },
  { id: "laps", label: "Lap times" },
  { id: "stints", label: "Tyres" },
];

const COMPOUND_COLOUR: Record<string, string> = {
  soft: "#e3322b",
  medium: "#f2c230",
  hard: "#f4f4f4",
  intermediate: "#1fd65f",
  wet: "#3aa0ff",
};

/**
 * The tabbed body of a race result: the classification, then what happened
 * (lap chart, lap times, tyre stints) from the lap log the race kept.
 */
export function DebriefTabs({
  debrief,
  rows,
  classification,
}: {
  debrief: DebriefData;
  rows: ClassifiedRow[];
  classification: React.ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("classification");
  return (
    <>
      <div className={styles.debriefTabs} role="tablist" aria-label="Race debrief">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={styles.debriefTab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.debriefBody}>
        {tab === "classification" && classification}
        {tab === "positions" && <LapChart debrief={debrief} />}
        {tab === "laps" && <LapTimes debrief={debrief} rows={rows} />}
        {tab === "stints" && <Stints debrief={debrief} />}
      </div>
    </>
  );
}

const CHART_W = 760;
const ROW_H = 17;
const PAD_L = 30;
const PAD_R = 54;
const PAD_T = 12;

function LapChart({ debrief }: { debrief: DebriefData }) {
  const laps = debrief.positions.length;
  const cars = debrief.cars.length;
  if (laps === 0) return <p className={styles.debriefEmpty}>No laps were logged.</p>;
  const height = PAD_T + cars * ROW_H + 8;
  const x = (lap: number) => PAD_L + (laps === 1 ? 0 : ((lap - 1) / (laps - 1)) * (CHART_W - PAD_L - PAD_R));
  const y = (pos: number) => PAD_T + (pos - 0.5) * ROW_H;
  const line = (car: number) => {
    const pts: string[] = [];
    debrief.positions.forEach((row, i) => {
      if (row[car] > 0) pts.push(`${x(i + 1).toFixed(1)},${y(row[car]).toFixed(1)}`);
    });
    return pts.join(" ");
  };
  const order = debrief.cars.map((_, i) => i).sort((a, b) => Number(a === 0) - Number(b === 0));
  const last = debrief.positions[laps - 1];
  return (
    <svg className={styles.debriefChart} viewBox={`0 0 ${CHART_W} ${height}`} role="img" aria-label="Running order at the end of each lap">
      {Array.from({ length: cars }, (_, p) => (
        <text key={p} x={PAD_L - 8} y={y(p + 1) + 4} textAnchor="end" className={styles.debriefAxis}>
          {p + 1}
        </text>
      ))}
      {Array.from({ length: laps }, (_, l) => (
        <text key={l} x={x(l + 1)} y={height - 0} textAnchor="middle" className={styles.debriefAxis}>
          {laps > 12 && (l + 1) % 2 === 0 ? "" : l + 1}
        </text>
      ))}
      {order.map((car) => {
        const you = debrief.cars[car].isPlayer;
        return (
          <polyline
            key={car}
            points={line(car)}
            fill="none"
            stroke={you ? safeHex(debrief.cars[car].color) : "#6b7280"}
            strokeWidth={you ? 3.5 : 1.4}
            strokeOpacity={you ? 1 : 0.7}
            strokeLinejoin="round"
          />
        );
      })}
      {debrief.cars.map((c, car) =>
        last[car] > 0 ? (
          <text
            key={car}
            x={x(laps) + 8}
            y={y(last[car]) + 4}
            className={c.isPlayer ? styles.debriefLabelYou : styles.debriefLabel}
          >
            {c.code}
          </text>
        ) : null
      )}
    </svg>
  );
}

function LapTimes({ debrief, rows }: { debrief: DebriefData; rows: ClassifiedRow[] }) {
  const codeIndex = (code: string | undefined) => (code ? debrief.cars.findIndex((c) => c.code === code) : -1);
  const winner = codeIndex(rows[0]?.code);
  const player = rows.find((r) => r.isPlayer);
  const mate = codeIndex(rows.find((r) => !r.isPlayer && r.teamId !== null && r.teamId === player?.teamId)?.code);
  const laps = debrief.positions.length;
  const t = (car: number, lap: number) => (car >= 0 ? debrief.lapTimes[car]?.[lap] ?? null : null);
  const yourBest = Math.min(...(debrief.lapTimes[0] ?? []).filter((s) => s > 0), Infinity);
  const showWinner = winner > 0;
  return (
    <table className={styles.resultTable}>
      <thead>
        <tr>
          <th>LAP</th>
          <th>YOU</th>
          {showWinner && <th>{debrief.cars[winner].code} (WINNER)</th>}
          {mate >= 0 && <th>{debrief.cars[mate].code} (TEAMMATE)</th>}
          {showWinner && <th>VS WINNER</th>}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: laps }, (_, lap) => {
          const mine = t(0, lap);
          const theirs = showWinner ? t(winner, lap) : null;
          const isFastest = debrief.fastest?.car === 0 && debrief.fastest.lap === lap + 1;
          return (
            <tr key={lap}>
              <td className={styles.resultPos}>{lap + 1}</td>
              <td
                className={styles.resultNum}
                data-fastest={isFastest ? "1" : undefined}
                data-best={mine !== null && mine === yourBest ? "1" : undefined}
              >
                {mine === null ? "—" : formatLapTime(mine)}
              </td>
              {showWinner && <td className={styles.resultNum}>{theirs === null ? "—" : formatLapTime(theirs)}</td>}
              {mate >= 0 && <td className={styles.resultNum}>{t(mate, lap) === null ? "—" : formatLapTime(t(mate, lap))}</td>}
              {showWinner && (
                <td className={styles.resultNum}>
                  {mine !== null && theirs !== null ? `${mine - theirs >= 0 ? "+" : "−"}${Math.abs(mine - theirs).toFixed(3)}` : "—"}
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Stints({ debrief }: { debrief: DebriefData }) {
  const stints: { compound: string; from: number; to: number }[] = [];
  debrief.compounds.forEach((c, i) => {
    const prev = stints[stints.length - 1];
    if (prev && prev.compound === c) prev.to = i + 1;
    else stints.push({ compound: c, from: i + 1, to: i + 1 });
  });
  if (stints.length === 0) return <p className={styles.debriefEmpty}>No laps were logged.</p>;
  const total = debrief.compounds.length;
  return (
    <div className={styles.stintWrap}>
      <div className={styles.stintBar} role="img" aria-label="Your tyre stints">
        {stints.map((s) => (
          <div
            key={s.from}
            className={styles.stint}
            style={{ flexGrow: s.to - s.from + 1, background: COMPOUND_COLOUR[s.compound] ?? "#9aa0ac" }}
          >
            <b>{s.compound.slice(0, 1).toUpperCase()}</b>
            <span>
              L{s.from}
              {s.to > s.from ? `–${s.to}` : ""}
            </span>
          </div>
        ))}
      </div>
      <p className={styles.debriefEmpty}>
        {stints.length === 1
          ? `You ran ${total} ${total === 1 ? "lap" : "laps"} on one set.`
          : `${stints.length - 1} pit ${stints.length === 2 ? "stop" : "stops"}.`}{" "}
        Your stints only: rivals&apos; stops are not logged.
      </p>
    </div>
  );
}
