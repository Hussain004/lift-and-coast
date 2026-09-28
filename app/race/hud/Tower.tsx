"use client";

import { useEffect, useRef } from "react";
import { compactTowerRows, towerGapLabel, type HudSnapshot } from "@/lib/race/hud";
import { escapeHtml, safeHex, useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

/** How long a position change keeps its arrow. */
const CHANGE_MS = 3000;

/**
 * Top-left timing tower, broadcast style: the header carries the position
 * and lap, the body five rows (leader, the cars either side of you, you)
 * until Tab expands it to the whole field.
 */
export function Tower({
  hudRef,
  trackName,
  initialRows,
}: {
  hudRef: React.RefObject<HudSnapshot>;
  trackName: string;
  /** First paint before lights out: the grid order, no gaps. */
  initialRows: { code: string; color: string; grid: number; isPlayer: boolean }[];
}) {
  const posRef = useRef<HTMLSpanElement>(null);
  const lapRef = useRef<HTMLSpanElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(false);
  const drawnRef = useRef({ version: -1, expanded: false, lap: "", pos: "" });
  const changesRef = useRef(new Map<string, { at: number; up: boolean; last: number }>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Tab" || e.repeat) return;
      e.preventDefault();
      expandedRef.current = !expandedRef.current;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useHudFrame((now) => {
    const hud = hudRef.current;
    const drawn = drawnRef.current;
    const lap =
      hud.sessionMode === "race"
        ? `LAP ${Math.min(hud.lap, hud.totalLaps)}/${hud.totalLaps}`
        : hud.phase ?? "";
    if (lapRef.current && lap !== drawn.lap) {
      lapRef.current.textContent = lap;
      drawn.lap = lap;
    }
    const pos = hud.tower.length > 0 ? `P${hud.position}` : "";
    if (posRef.current && pos !== drawn.pos) {
      posRef.current.textContent = pos;
      drawn.pos = pos;
    }
    if (rootRef.current) rootRef.current.dataset.chequered = hud.chequered ? "1" : "0";
    if (!rowsRef.current || hud.tower.length === 0) return;
    if (hud.towerVersion === drawn.version && expandedRef.current === drawn.expanded) return;
    drawn.version = hud.towerVersion;
    drawn.expanded = expandedRef.current;

    const ordered = [...hud.tower].sort((a, b) => a.position - b.position);
    const changes = changesRef.current;
    for (const entry of ordered) {
      const prev = changes.get(entry.code);
      if (!prev) changes.set(entry.code, { at: 0, up: false, last: entry.position });
      else if (prev.last !== entry.position) {
        changes.set(entry.code, { at: now, up: entry.position < prev.last, last: entry.position });
      }
    }
    const playerIndex = Math.max(0, ordered.findIndex((e) => e.isPlayer));
    const show = expandedRef.current
      ? ordered.map((_, i) => i)
      : compactTowerRows(ordered.length, playerIndex);
    let html = "";
    show.forEach((index, n) => {
      const entry = ordered[index];
      const gap = index === 0 ? "LEADER" : towerGapLabel(entry.intervalSeconds, entry.intervalLapsDown);
      const change = changes.get(entry.code);
      const arrow =
        change && now - change.at < CHANGE_MS
          ? `<i class="${change.up ? styles.up : styles.down}">${change.up ? "▲" : "▼"}</i>`
          : "";
      const skipped = n > 0 && index !== show[n - 1] + 1;
      html +=
        `<div class="${styles.towerRow}${entry.isPlayer ? ` ${styles.towerRowYou}` : ""}${skipped ? ` ${styles.towerGapAbove}` : ""}">` +
        `<span class="${styles.towerPos}">${entry.position}</span>` +
        `<span class="${styles.towerTeam}" style="background:${safeHex(entry.color)}"></span>` +
        `<span class="${styles.towerCode}">${escapeHtml(entry.code)}${entry.isFastestLap ? `<b class="${styles.fastestDot}" title="Fastest lap"></b>` : ""}</span>` +
        `${arrow}<span class="${styles.towerGap}">${gap}</span></div>`;
    });
    rowsRef.current.innerHTML = html;
  }, 20);

  return (
    <div className={styles.tower} ref={rootRef}>
      <div className={styles.towerHead}>
        <span className={styles.towerPosBig} ref={posRef} />
        <span className={styles.towerLap} ref={lapRef} />
      </div>
      <div className={styles.towerEvent}>{trackName}</div>
      <div className={styles.towerRows} ref={rowsRef}>
        {initialRows.slice(0, 5).map((row) => (
          <div className={`${styles.towerRow}${row.isPlayer ? ` ${styles.towerRowYou}` : ""}`} key={row.code}>
            <span className={styles.towerPos}>{row.grid}</span>
            <span className={styles.towerTeam} style={{ background: safeHex(row.color) }} />
            <span className={styles.towerCode}>{row.code}</span>
            <span className={styles.towerGap}>GRID</span>
          </div>
        ))}
      </div>
      <div className={styles.towerHint}>TAB · FULL ORDER</div>
    </div>
  );
}
