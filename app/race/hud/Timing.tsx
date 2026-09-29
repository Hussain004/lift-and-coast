"use client";

import { useRef, useState } from "react";
import { formatLapTime } from "@/lib/race/lapTimer";
import { formatGap, pitPrompt, type HudEvent, type HudSnapshot } from "@/lib/race/hud";
import { useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Top-centre timing: the running lap (or the qualifying clock), the three
 * sector blocks in timing colours, and the delta pill under them.
 */
export function Timing({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const bestRef = useRef<HTMLSpanElement>(null);
  const sectorRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const deltaRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useHudFrame(() => {
    const hud = hudRef.current;
    if (labelRef.current) {
      labelRef.current.textContent =
        hud.clockSeconds !== null ? `${hud.phase ?? "QUALIFYING"} · ${clock(hud.clockSeconds)}` : hud.phase ?? "LAP TIME";
    }
    if (timeRef.current) timeRef.current.textContent = formatLapTime(hud.lapSeconds);
    if (bestRef.current) bestRef.current.textContent = `BEST ${formatLapTime(hud.bestLapSeconds)}`;
    if (rootRef.current) rootRef.current.dataset.invalid = hud.lapInvalid ? "1" : "0";
    hud.sectors.forEach((sector, i) => {
      const el = sectorRefs.current[i];
      if (!el) return;
      el.dataset.color = sector?.color ?? "";
      el.textContent = sector ? sector.seconds.toFixed(3) : `S${i + 1}`;
    });
    const delta = deltaRef.current;
    if (delta) {
      delta.textContent = hud.delta === null ? "" : formatGap(hud.delta, 3);
      delta.dataset.sign = hud.delta === null ? "" : hud.delta > 0 ? "behind" : "ahead";
    }
  });

  return (
    <div className={styles.timing} ref={rootRef}>
      <div className={styles.timingMain}>
        <span className={styles.timingLabel} ref={labelRef} />
        <span className={styles.timingTime} ref={timeRef} />
        <span className={styles.timingInvalid}>INVALID</span>
      </div>
      <div className={styles.sectors}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={styles.sector}
            ref={(el) => {
              sectorRefs.current[i] = el;
            }}
          />
        ))}
      </div>
      <span className={styles.timingBest} ref={bestRef} />
      <div className={styles.delta} ref={deltaRef} />
    </div>
  );
}

/**
 * Banners: flags, penalties, personal bests, knockout calls - one queue (the
 * snapshot's events), two on screen at most, newest on top. The live
 * track-limits state sits above them while all four wheels are off.
 */
export function Notifications({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const [shown, setShown] = useState<(HudEvent & { until: number })[]>([]);
  const seenRef = useRef(0);
  const limitRef = useRef<HTMLDivElement>(null);
  const pitRef = useRef<HTMLDivElement>(null);
  const flagRef = useRef<HTMLDivElement>(null);

  useHudFrame((now) => {
    const hud = hudRef.current;
    if (limitRef.current) {
      limitRef.current.textContent = hud.trackLimitText;
      limitRef.current.dataset.on = hud.trackLimitText ? "1" : "0";
    }
    if (flagRef.current) {
      flagRef.current.textContent = hud.flagText;
      flagRef.current.dataset.on = hud.flagText ? "1" : "0";
      flagRef.current.dataset.kind = hud.flagText.startsWith("BLUE") ? "blue" : "yellow";
    }
    if (pitRef.current) {
      const text = pitPrompt(hud);
      pitRef.current.textContent = text;
      pitRef.current.dataset.on = text ? "1" : "0";
      pitRef.current.dataset.go = hud.pitPhase === "service" ? "1" : "0";
    }
    const fresh = hud.events.filter((e) => e.id > seenRef.current);
    const expired = shown.some((e) => e.until <= now);
    if (fresh.length === 0 && !expired) return;
    if (fresh.length > 0) seenRef.current = fresh[fresh.length - 1].id;
    setShown((current) =>
      [...fresh.reverse().map((e) => ({ ...e, until: now + e.seconds * 1000 })), ...current]
        .filter((e) => e.until > now)
        .slice(0, 2)
    );
  }, 15);

  return (
    <div className={styles.notices} aria-live="polite">
      <div className={styles.limitChip} ref={limitRef} data-on="0" />
      <div className={styles.flagChip} ref={flagRef} data-on="0" />
      <div className={styles.pitChip} ref={pitRef} data-on="0" />
      {shown.map((e) => (
        <div key={e.id} className={styles.notice} data-kind={e.kind}>
          <strong>{e.title}</strong>
          {e.detail && <span>{e.detail}</span>}
        </div>
      ))}
    </div>
  );
}
