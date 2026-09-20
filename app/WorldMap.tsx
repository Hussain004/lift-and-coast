"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
  useSessionTrackId,
} from "@/lib/race/sessionSetup";
import { TRACKS } from "@/lib/tracks/registry";
import {
  WORLD_MAP_H,
  WORLD_MAP_W,
  fullWorldView,
  getLandPolygons,
  getOutline,
  landPath,
  mapViewBox,
  outlinePath,
  panMapView,
  previewStats,
  projectPin,
  zoomMapView,
  type MapView,
} from "@/lib/tracks/preview";
import styles from "./worldMap.module.css";

// Plan section 8 (World Map, Track Preview): the circuit picker as a real
// zoomable world map plus a top-down outline of the picked track with its
// stats. Coastlines are vendored Natural Earth 110m geometry (see
// lib/tracks/preview.ts), drawn once as a single path - zoom and pan only
// rewrite the SVG viewBox, never re-project. The pins are the session's
// track picker (they replaced SessionSetup's button row), so clicking one
// persists straight into the session prefs the Drive link reads.
const MAP_BUTTON_ZOOM = 1.6;
const PREVIEW_PX = 190;
// Drag distance in screen px past which a press is a pan, not a pin click.
const DRAG_PICK_THRESHOLD_PX = 4;

export function WorldMap() {
  const trackId = useSessionTrackId();
  const meta = TRACKS.find((t) => t.id === trackId) ?? TRACKS[0];
  const outline = getOutline(meta.id);
  const stats = previewStats(meta);
  const fitted = outlinePath(outline.points, PREVIEW_PX, 14);
  const land = useMemo(() => landPath(getLandPolygons()), []);

  const [view, setView] = useState<MapView>(() => fullWorldView());
  const svgRef = useRef<SVGSVGElement>(null);
  // Hovered (or keyboard-focused) pin for the name popover: the picked
  // track already labels itself, so this only fires for the rest.
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const panRef = useRef<{ startX: number; startY: number; view: MapView } | null>(null);
  // A drag that starts on a pin still releases over it, which would click it
  // - so a press that travels past the drag threshold disarms the click.
  const suppressClickRef = useRef(false);

  const pick = (id: string) => {
    const { raceLaps, timeOfDay, rivals, difficulty } = loadSessionSetupPrefs();
    saveSessionSetupPrefs({ raceLaps, trackId: id, timeOfDay, rivals, difficulty });
  };

  // Wheel-zoom about the cursor. Native listener (not React's onWheel) so
  // preventDefault actually suppresses the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      setView((v) => {
        const anchorX = v.x + ((e.clientX - rect.left) / rect.width) * v.w;
        const anchorY = v.y + ((e.clientY - rect.top) / rect.height) * (v.w / WORLD_MAP_W) * WORLD_MAP_H;
        return zoomMapView(v, anchorX, anchorY, Math.exp(-e.deltaY * 0.0015));
      });
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, []);

  const toSvgDelta = (dxPx: number, dyPx: number) => {
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { dx: 0, dy: 0 };
    const unit = view.w / rect.width;
    return { dx: dxPx * unit, dy: dyPx * unit };
  };

  // Inverse pin scale: dots and labels stay a constant screen size at any
  // zoom instead of swelling into dinner plates.
  const k = view.w / WORLD_MAP_W;

  return (
    <div className={styles.setup}>
      <div className={styles.label}>WORLD MAP</div>
      <svg
        ref={svgRef}
        viewBox={mapViewBox(view)}
        className={styles.map}
        role="radiogroup"
        aria-label="Circuit map"
        onPointerDown={(e) => {
          (e.target as SVGElement).setPointerCapture?.(e.pointerId);
          suppressClickRef.current = false;
          panRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            view,
          };
        }}
        onPointerMove={(e) => {
          const pan = panRef.current;
          if (!pan) return;
          if (
            Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) >
            DRAG_PICK_THRESHOLD_PX
          ) {
            suppressClickRef.current = true;
          }
          const { dx, dy } = toSvgDelta(pan.startX - e.clientX, pan.startY - e.clientY);
          setView(panMapView(pan.view, dx, dy));
        }}
        onPointerUp={() => {
          panRef.current = null;
        }}
        onPointerCancel={() => {
          panRef.current = null;
        }}
      >
        <path d={land} className={styles.land} />
        {TRACKS.map((t) => {
          const { x, y } = projectPin(t.lat, t.lon, WORLD_MAP_W, WORLD_MAP_H);
          const active = t.id === meta.id;
          const flip = x > WORLD_MAP_W - 90;
          return (
            <g
              key={t.id}
              role="radio"
              aria-checked={active}
              aria-label={t.name}
              tabIndex={0}
              className={styles.pin}
              transform={`translate(${x},${y}) scale(${k})`}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId((id) => (id === t.id ? null : id))}
              onFocus={() => setHoveredId(t.id)}
              onBlur={() => setHoveredId((id) => (id === t.id ? null : id))}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                pick(t.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  pick(t.id);
                }
              }}
            >
              <title>{t.name}</title>
              {active && <circle r={10} className={styles.pinRing} />}
              <circle r={5} className={active ? styles.pinActive : styles.pinDot} />
              {(active || hoveredId === t.id) && (
                <text
                  x={flip ? -12 : 12}
                  y={4}
                  textAnchor={flip ? "end" : "start"}
                  className={active ? styles.pinLabel : styles.pinHover}
                >
                  {t.shortName}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className={styles.mapControls}>
        <button type="button" className={styles.mapButton} onClick={() => setView((v) => zoomMapView(v, v.x + v.w / 2, v.y + ((v.w / WORLD_MAP_W) * WORLD_MAP_H) / 2, MAP_BUTTON_ZOOM))} aria-label="Zoom in">
          +
        </button>
        <button type="button" className={styles.mapButton} onClick={() => setView((v) => zoomMapView(v, v.x + v.w / 2, v.y + ((v.w / WORLD_MAP_W) * WORLD_MAP_H) / 2, 1 / MAP_BUTTON_ZOOM))} aria-label="Zoom out">
          −
        </button>
        <button type="button" className={styles.mapButton} onClick={() => setView(fullWorldView())}>
          RESET
        </button>
      </div>
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
      {/* Circuit list: the same picker as the pins above, as a list - with
          20 circuits a pin map alone is hunt-and-peck. Both read and write
          the same session prefs (see pick), so they can never disagree. */}
      <div className={styles.label}>CIRCUITS — {TRACKS.length}</div>
      <div className={styles.trackList} role="listbox" aria-label="Circuit list">
        {TRACKS.map((t) => {
          const active = t.id === meta.id;
          const rowStats = previewStats(t);
          return (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => pick(t.id)}
              className={active ? styles.trackRowActive : styles.trackRow}
            >
              <span className={styles.trackRowName}>{t.shortName}</span>
              <span className={styles.trackRowMeta}>
                {rowStats.length} · {rowStats.corners} corners
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
