"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DEFAULT_RACE_LAPS,
  DEFAULT_RIVALS,
  MAX_RACE_LAPS,
  MAX_RIVALS,
  MIN_RACE_LAPS,
  MIN_RIVALS,
  buildRaceUrl,
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
  useSessionSetupPrefs,
  type QualifyingFormat,
  type SessionMode,
  type TimeOfDay,
} from "@/lib/race/sessionSetup";
import {
  DIFFICULTY_OPTIONS,
  type AIDifficulty,
} from "@/lib/ai/personalities";
import { parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { TRACKS, parseTrackId } from "@/lib/tracks/registry";
import { getOutline, outlinePath, previewStats } from "@/lib/tracks/preview";
import type { WeatherPreset } from "@/lib/physics/weather";
import {
  GRAPHICS_OPTIONS,
  loadGraphicsPref,
  saveGraphicsPref,
  type GraphicsPref,
} from "@/lib/render/quality";
import styles from "./sessionSetup.module.css";

const TIME_OF_DAY_OPTIONS: { id: TimeOfDay; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "sunset", label: "Sunset" },
  { id: "overcast", label: "Overcast" },
];

const WEATHER_OPTIONS: { id: WeatherPreset; label: string }[] = [
  { id: "clear", label: "Clear" },
  { id: "cloudy", label: "Cloudy" },
  { id: "rain", label: "Rain" },
];

const SESSION_MODES: { id: SessionMode; label: string }[] = [
  { id: "practice", label: "Practice" },
  { id: "qualifying", label: "Qualifying" },
  { id: "race", label: "Race" },
];

const QUALI_FORMATS: { id: QualifyingFormat; label: string }[] = [
  { id: "knockout", label: "Knockout Q1-Q3" },
  { id: "timed", label: "10 min" },
  { id: "oneshot", label: "One-shot" },
];

// Plan section 8 (Session Setup): the lap-count slider plus the Drive link.
// The track picker used to be a button row here; it now lives on the world
// map pins above (app/WorldMap.tsx), and this panel reads the same shared
// trackId through the session-setup change event - one picker, two readers.
// Persists the last picks (plan section 10) so the next session opens the
// way the previous one left it. Difficulty tiers scale the AI field's pace
// and aggression only (see lib/ai/personalities.ts) - the player's car is
// untouched. Pro is the calibrated fast-line reference, so old links (which
// carry no ?diff=) open on the new Pro regime.
export function SessionSetup() {
  const initial = loadSessionSetupPrefs();
  const [raceLaps, setRaceLaps] = useState(initial.raceLaps);
  const [rivals, setRivals] = useState(initial.rivals);
  const [difficulty, setDifficulty] = useState<AIDifficulty>(initial.difficulty);
  const [sessionMode, setSessionMode] = useState<SessionMode>("race");
  const [qualiFormat, setQualiFormat] = useState<QualifyingFormat>("timed");
  const [weather, setWeather] = useState<WeatherPreset>(initial.weather);
  const { trackId, timeOfDay } = useSessionSetupPrefs();
  // Live roster pick from the team/driver panel above - carried on the Drive
  // link so the race grid dresses both cars (see lib/race/roster.ts).
  const { teamId, driverCode } = useRosterSelection();
  const router = useRouter();
  // Graphics tier (see lib/render/quality.ts), persisted like the rest.
  const [graphics, setGraphics] = useState<GraphicsPref>(() => loadGraphicsPref());
  const meta = TRACKS.find((t) => t.id === trackId) ?? TRACKS[0];
  const stats = previewStats(meta);
  const hero = outlinePath(getOutline(meta.id).points, 150, 10);

  function driveUrl(seed: number | undefined) {
    return buildRaceUrl({
      mode: sessionMode,
      track: parseTrackId(trackId),
      laps: sessionMode === "qualifying" ? undefined : raceLaps,
      team: parseTeamId(teamId),
      driver: parseDriverCode(driverCode),
      tod: timeOfDay,
      weather,
      qformat: sessionMode === "qualifying" ? qualiFormat : undefined,
      rivals: sessionMode === "practice" ? undefined : rivals,
      difficulty: sessionMode === "practice" ? undefined : difficulty,
      // A fresh grid every Drive click (see ?seed=): plain clicks deal
      // via router so each visit shuffles; modified clicks / new tabs
      // follow the seedless href and keep the legacy pole start.
      seed: sessionMode === "race" ? seed : undefined,
    });
  }

  const persist = (
    laps: number,
    id: string,
    tod: TimeOfDay,
    weatherPreset: WeatherPreset = weather,
    rivalCount: number = rivals,
    diff: AIDifficulty = difficulty
  ) => {
    saveSessionSetupPrefs({ raceLaps: laps, trackId: id, timeOfDay: tod, weather: weatherPreset, rivals: rivalCount, difficulty: diff });
  };

  return (
    <div className={styles.setup}>
      <div className={styles.circuit}>
        <svg width={150} height={150} viewBox="0 0 150 150" className={styles.circuitOutline} role="img" aria-label={`${meta.name} outline`}>
          <path d={hero.d} />
          <circle cx={hero.start.x} cy={hero.start.y} r={4} className={styles.circuitStart} />
        </svg>
        <div className={styles.circuitInfo}>
          <div className={styles.circuitName}>{meta.name}</div>
          <dl className={styles.circuitStats}>
            <dt>Length</dt>
            <dd>{stats.length}</dd>
            <dt>Corners</dt>
            <dd>{stats.corners}</dd>
            <dt>Direction</dt>
            <dd>{stats.direction}</dd>
          </dl>
        </div>
      </div>
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
      <div className={styles.label}>WEATHER</div>
      <div className={styles.presets} role="radiogroup" aria-label="Weather">
        {WEATHER_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={weather === option.id}
            onClick={() => {
              setWeather(option.id);
              persist(raceLaps, trackId, timeOfDay, option.id);
            }}
            className={weather === option.id ? styles.presetActive : styles.preset}
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className={styles.label}>SESSION</div>
      <div className={styles.presets} role="radiogroup" aria-label="Session mode">
        {SESSION_MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={sessionMode === option.id}
            onClick={() => setSessionMode(option.id)}
            className={sessionMode === option.id ? styles.presetActive : styles.preset}
          >
            {option.label}
          </button>
        ))}
      </div>
      {sessionMode === "qualifying" && (
        <div className={styles.presets} role="radiogroup" aria-label="Qualifying format">
          {QUALI_FORMATS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={qualiFormat === option.id}
              onClick={() => setQualiFormat(option.id)}
              className={qualiFormat === option.id ? styles.presetActive : styles.preset}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
      {sessionMode !== "qualifying" && (
        <>
          <div className={styles.sliderRow}>
            <span className={styles.label}>
              {sessionMode === "practice" ? "PRACTICE — LAPS" : "QUICK RACE — LAPS"}
            </span>
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
            aria-label="Session lap count"
          />
          <div className={styles.scale}>
            <span>{MIN_RACE_LAPS}</span>
            <span>{MAX_RACE_LAPS}</span>
          </div>
        </>
      )}
      {sessionMode !== "practice" && (
        <>
          <div className={styles.sliderRow}>
            <span className={styles.label}>RIVALS</span>
            <span className={styles.readout} aria-live="polite">
              {rivals}
            </span>
          </div>
          <input
            type="range"
            min={MIN_RIVALS}
            max={MAX_RIVALS}
            value={rivals}
            onChange={(e) => {
              const count = parseInt(e.target.value, 10);
              const clamped = Number.isFinite(count)
                ? Math.min(MAX_RIVALS, Math.max(MIN_RIVALS, count))
                : DEFAULT_RIVALS;
              setRivals(clamped);
              persist(raceLaps, trackId, timeOfDay, weather, clamped);
            }}
            className={styles.slider}
            aria-label="Rival count"
          />
          <div className={styles.scale}>
            <span>{MIN_RIVALS} (duel)</span>
            <span>{MAX_RIVALS} (full grid)</span>
          </div>
          <div className={styles.sliderRow}>
            <span className={styles.label}>AI LEVEL</span>
          </div>
          <div className={styles.presets} role="radiogroup" aria-label="AI difficulty">
            {DIFFICULTY_OPTIONS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={difficulty === option.id}
                title={option.blurb}
                onClick={() => {
                  setDifficulty(option.id);
                  persist(raceLaps, trackId, timeOfDay, weather, rivals, option.id);
                }}
                className={difficulty === option.id ? styles.presetActive : styles.preset}
              >
                {option.label}
              </button>
            ))}
          </div>
        </>
      )}
      <div className={styles.sliderRow}>
        <span className={styles.label}>GRAPHICS</span>
      </div>
      <div className={styles.presets} role="radiogroup" aria-label="Graphics quality">
        {GRAPHICS_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={graphics === option.id}
            title={option.id === "auto" ? "Detects your hardware and adapts live" : undefined}
            onClick={() => {
              setGraphics(option.id);
              saveGraphicsPref(option.id);
            }}
            className={graphics === option.id ? styles.presetActive : styles.preset}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Link
        href={driveUrl(undefined)}
        onClick={(e) => {
          // Plain left click only: deal a fresh grid, SPA-navigated. Let
          // modified clicks and middle-buttons take the plain href (they
          // open the legacy pole-start grid, never a broken one).
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          router.push(driveUrl((Math.random() * 2 ** 31) | 0));
        }}
        className={styles.drive}
      >
        Drive
      </Link>
    </div>
  );
}