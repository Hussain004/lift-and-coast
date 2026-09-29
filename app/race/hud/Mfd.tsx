"use client";

import { useEffect, useRef, useState } from "react";
import type { HudSnapshot } from "@/lib/race/hud";
import { forecastLabel } from "@/lib/physics/weatherForecast";
import { useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

const LEDS = 15;
/** The shift lights start filling at this fraction of the rev range. */
const LED_START = 0.5;

const PAGES = ["TYRES", "ENERGY", "CAR", "WEATHER"] as const;
type Page = (typeof PAGES)[number];

const COMPOUND_LETTER = { soft: "S", medium: "M", hard: "H", intermediate: "I", wet: "W" } as const;

function pct(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/**
 * Bottom-right multi-function display, the steering-wheel screen of the F1
 * game: shift lights, gear, speed, the ERS store and aero mode always on
 * show, and a paged lower half (`,` and `.` flip pages) for tyres, energy,
 * car and weather. Replaces the old strip of TYRE/AERO/ERS/FUEL cards.
 */
export function Mfd({ hudRef }: { hudRef: React.RefObject<HudSnapshot> }) {
  const [page, setPage] = useState<Page>("TYRES");
  const ledRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const gearRef = useRef<HTMLDivElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const ersFillRef = useRef<HTMLDivElement>(null);
  const ersLabelRef = useRef<HTMLSpanElement>(null);
  const aeroRef = useRef<HTMLSpanElement>(null);
  const otRef = useRef<HTMLSpanElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const inputsRef = useRef<HTMLDivElement>(null);
  const thrRef = useRef<HTMLDivElement>(null);
  const brkRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const step = e.code === "Period" ? 1 : e.code === "Comma" ? -1 : 0;
      if (!step) return;
      setPage((p) => PAGES[(PAGES.indexOf(p) + step + PAGES.length) % PAGES.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useHudFrame((now) => {
    const hud = hudRef.current;
    const lit = Math.round(Math.max(0, Math.min(1, (hud.rpm01 - LED_START) / (1 - LED_START))) * LEDS);
    const flash = hud.rpmZone === "shift" && Math.floor(now / 90) % 2 === 0;
    ledRefs.current.forEach((led, i) => {
      if (!led) return;
      led.dataset.on = flash ? "shift" : i < lit ? "1" : "0";
    });
    if (gearRef.current) gearRef.current.textContent = hud.gear;
    if (speedRef.current) speedRef.current.textContent = `${Math.round(hud.speedKmh)}`;
    if (ersFillRef.current) ersFillRef.current.style.transform = `scaleX(${Math.max(0, Math.min(1, hud.ers01)).toFixed(3)})`;
    if (ersLabelRef.current) ersLabelRef.current.textContent = `${hud.ersMode.toUpperCase()} ${pct(hud.ers01)}`;
    if (aeroRef.current) {
      aeroRef.current.textContent = hud.lowDrag ? "LOW DRAG" : "HIGH DF";
      aeroRef.current.dataset.low = hud.lowDrag ? "1" : "0";
    }
    if (otRef.current) otRef.current.dataset.on = hud.overtakeActive ? "1" : "0";
    if (inputsRef.current) inputsRef.current.hidden = !(hud.timeAttack || hud.sessionMode === "practice");
    if (thrRef.current) thrRef.current.style.transform = `scaleX(${hud.throttle.toFixed(3)})`;
    if (brkRef.current) brkRef.current.style.transform = `scaleX(${hud.brake.toFixed(3)})`;
    const el = pageRef.current;
    if (!el) return;
    const set = (key: string, value: string) => {
      const target = el.querySelector<HTMLElement>(`[data-k="${key}"]`);
      if (target && target.textContent !== value) target.textContent = value;
    };
    if (page === "TYRES") {
      set("compound", COMPOUND_LETTER[hud.compound]);
      el.dataset.compound = hud.compound;
      set("wear", pct(hud.tyreWear01));
      set("temp", `${Math.round(hud.tyreTempC)}°C`);
      set("grip", pct(hud.tyreGrip));
    } else if (page === "ENERGY") {
      set("battery", pct(hud.ers01));
      set("budget", pct(hud.deployBudget01));
      set("fuel", `${hud.fuelKg.toFixed(1)} kg`);
      set("strategy", hud.strategyMode.toUpperCase());
      set("pit", hud.pitPhase === "none" ? `${hud.pitStops} STOPS` : hud.pitPhase === "requested" ? "BOX REQUESTED" : "IN SERVICE");
      el.dataset.fuelWarn = hud.fuelWarning ? "1" : "0";
    } else if (page === "CAR") {
      set("tc", hud.tc ? "ON" : "OFF");
      set("abs", hud.abs ? "ON" : "OFF");
      set("gears", hud.autoGear ? "AUTO" : "MANUAL");
      set("line", hud.racingLine ? "ON" : "OFF");
      set("damage", hud.damage >= 0.999 ? "NONE" : `${Math.round((1 - hud.damage) * 100)}% GRIP LOST`);
      el.dataset.damaged = hud.damage < 0.999 ? "1" : "0";
    } else {
      set("weather", hud.weather.toUpperCase());
      set("track", `${Math.round(hud.trackTempC)}°C`);
      set("forecast", forecastLabel(hud.forecastInSeconds === null || !hud.forecastTo ? null : { inSeconds: hud.forecastInSeconds, preset: hud.forecastTo }) ?? "STABLE");
    }
  });

  return (
    <div className={styles.mfd}>
      <div className={styles.leds} aria-hidden="true">
        {Array.from({ length: LEDS }, (_, i) => (
          <span
            key={i}
            className={styles.led}
            data-band={i < 5 ? "g" : i < 10 ? "r" : "b"}
            ref={(el) => {
              ledRefs.current[i] = el;
            }}
          />
        ))}
      </div>
      <div className={styles.mfdCore}>
        <div className={styles.gear} ref={gearRef}>N</div>
        <div className={styles.speedBlock}>
          <div className={styles.speed} ref={speedRef}>0</div>
          <div className={styles.speedUnit}>KM/H</div>
        </div>
        <div className={styles.mfdChips}>
          <span className={styles.aero} ref={aeroRef} />
          <span className={styles.overtake} ref={otRef}>OVERTAKE</span>
        </div>
      </div>
      <div className={styles.ers}>
        <div className={styles.ersTrack}>
          <div className={styles.ersFill} ref={ersFillRef} />
        </div>
        <span className={styles.ersLabel} ref={ersLabelRef} />
      </div>
      <div className={styles.inputs} ref={inputsRef} hidden>
        <div className={styles.inputTrack}>
          <div className={styles.inputThr} ref={thrRef} />
        </div>
        <div className={styles.inputTrack}>
          <div className={styles.inputBrk} ref={brkRef} />
        </div>
      </div>
      <div className={styles.mfdPage} ref={pageRef}>
        <div className={styles.mfdTabs}>
          <button type="button" onClick={() => setPage(PAGES[(PAGES.indexOf(page) + PAGES.length - 1) % PAGES.length])} aria-label="Previous page">
            ‹
          </button>
          <span>{page}</span>
          <button type="button" onClick={() => setPage(PAGES[(PAGES.indexOf(page) + 1) % PAGES.length])} aria-label="Next page">
            ›
          </button>
        </div>
        {page === "TYRES" && (
          <div className={styles.mfdGrid}>
            <span className={styles.compound} data-k="compound" />
            <dl>
              <div><dt>WEAR</dt><dd data-k="wear" /></div>
              <div><dt>TEMP</dt><dd data-k="temp" /></div>
              <div><dt>GRIP</dt><dd data-k="grip" /></div>
            </dl>
          </div>
        )}
        {page === "ENERGY" && (
          <dl className={styles.mfdList}>
            <div><dt>BATTERY</dt><dd data-k="battery" /></div>
            <div><dt>DEPLOY LEFT</dt><dd data-k="budget" /></div>
            <div><dt>FUEL</dt><dd data-k="fuel" /></div>
            <div><dt>STRATEGY</dt><dd data-k="strategy" /></div>
            <div><dt>PIT</dt><dd data-k="pit" /></div>
          </dl>
        )}
        {page === "CAR" && (
          <dl className={styles.mfdList}>
            <div><dt>TC</dt><dd data-k="tc" /></div>
            <div><dt>ABS</dt><dd data-k="abs" /></div>
            <div><dt>GEARBOX</dt><dd data-k="gears" /></div>
            <div><dt>RACING LINE</dt><dd data-k="line" /></div>
            <div><dt>DAMAGE</dt><dd data-k="damage" /></div>
          </dl>
        )}
        {page === "WEATHER" && (
          <dl className={styles.mfdList}>
            <div><dt>CONDITIONS</dt><dd data-k="weather" /></div>
            <div><dt>TRACK</dt><dd data-k="track" /></div>
            <div><dt>FORECAST</dt><dd data-k="forecast" /></div>
          </dl>
        )}
      </div>
    </div>
  );
}
