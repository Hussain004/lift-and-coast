"use client";

import {
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
  useSessionTrackId,
} from "@/lib/race/sessionSetup";
import { TRACKS } from "@/lib/tracks/registry";
import {
  getOutline,
  outlinePath,
  previewStats,
  projectPin,
} from "@/lib/tracks/preview";
import styles from "./worldMap.module.css";

// Plan section 8 (World Map, Track Preview): the circuit picker as a map
// plus a top-down outline of the picked track with its stats. The pins are
// the session's track picker now (they replaced SessionSetup's button row),
// so clicking one persists straight into the session prefs the Drive link
// reads - the world map highlight and the Drive link stay in sync through
// the shared session-setup change event, same as the roster panels.
const MAP_W = 520;
const MAP_H = 170;
const PREVIEW_PX = 190;

const MERIDIANS = [-120, -60, 0, 60, 120];
const PARALLELS = [-60, -30, 0, 30, 60];

export function WorldMap() {
  const trackId = useSessionTrackId();
  const meta = TRACKS.find((t) => t.id === trackId) ?? TRACKS[0];
  const outline = getOutline(meta.id);
  const stats = previewStats(meta);
  const fitted = outlinePath(outline.points, PREVIEW_PX, 14);

  const pick = (id: string) => {
    const { raceLaps } = loadSessionSetupPrefs();
    saveSessionSetupPrefs({ raceLaps, trackId: id });
  };

  return (
    <div className={styles.setup}>
      <div className={styles.label}>WORLD MAP</div>
      <svg
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        className={styles.map}
        role="radiogroup"
        aria-label="Circuit map"
      >
        {MERIDIANS.map((lon) => {
          const x = ((lon + 180) / 360) * MAP_W;
          return (
            <line
              key={lon}
              x1={x}
              y1={0}
              x2={x}
              y2={MAP_H}
              className={lon === 0 ? styles.graticuleBright : styles.graticule}
            />
          );
        })}
        {PARALLELS.map((lat) => {
          const y = ((90 - lat) / 180) * MAP_H;
          return (
            <line
              key={lat}
              x1={0}
              y1={y}
              x2={MAP_W}
              y2={y}
              className={lat === 0 ? styles.graticuleBright : styles.graticule}
            />
          );
        })}
        {TRACKS.map((t) => {
          const { x, y } = projectPin(t.lat, t.lon, MAP_W, MAP_H);
          const active = t.id === meta.id;
          const flip = x > MAP_W - 80;
          return (
            <g
              key={t.id}
              role="radio"
              aria-checked={active}
              aria-label={t.name}
              tabIndex={0}
              className={styles.pin}
              onClick={() => pick(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(t.id);
                }
              }}
            >
              <title>{t.name}</title>
              {active && (
                <circle cx={x} cy={y} r={10} className={styles.pinRing} />
              )}
              <circle
                cx={x}
                cy={y}
                r={5}
                className={active ? styles.pinActive : styles.pinDot}
              />
              {active && (
                <text
                  x={flip ? x - 12 : x + 12}
                  y={y + 4}
                  textAnchor={flip ? "end" : "start"}
                  className={styles.pinLabel}
                >
                  {t.shortName}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className={styles.preview}>
        <svg
          width={PREVIEW_PX}
          height={PREVIEW_PX}
          viewBox={`0 0 ${PREVIEW_PX} ${PREVIEW_PX}`}
          className={styles.outline}
          role="img"
          aria-label={`${meta.name} outline`}
        >
          <path d={fitted.d} fill="none" stroke="#fff" strokeWidth={2.5} />
          <circle cx={fitted.start.x} cy={fitted.start.y} r={3.5} fill="#ffd23f" />
        </svg>
        <div className={styles.stats}>
          <div className={styles.trackName}>{meta.name}</div>
          <div className={styles.statRow}>
            <span>LENGTH</span>
            <span>{stats.length}</span>
          </div>
          <div className={styles.statRow}>
            <span>CORNERS</span>
            <span>{stats.corners}</span>
          </div>
          <div className={styles.statRow}>
            <span>DIRECTION</span>
            <span>{stats.direction}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
