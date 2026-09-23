"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  loadSessionSetupPrefs,
  saveSessionSetupPrefs,
  useSessionTrackId,
} from "@/lib/race/sessionSetup";
import { TRACKS } from "@/lib/tracks/registry";
import {
  MAP_REGIONS,
  WORLD_MAP_H,
  WORLD_MAP_W,
  fullWorldView,
  getLandPolygons,
  getOutline,
  landPath,
  mapViewBox,
  outlinePath,
  panMapView,
  placeLabels,
  previewStats,
  projectPin,
  regionOf,
  regionView,
  zoomMapView,
  type MapRegion,
  type MapView,
} from "@/lib/tracks/preview";
import styles from "./worldMap.module.css";

// Plan section 8 (World Map): the circuit browser. Region chips zoom the
// map and filter the cards together - with 27 circuits, a dozen of them in
// Europe, a world-scale pin map alone is hunt-and-peck. Pins get a large
// invisible hit target; cards carry each circuit's outline. Both write the
// same session prefs the Drive link reads, so they can never disagree.
// Coastlines are vendored Natural Earth geometry drawn once as one path;
// zoom and pan only rewrite the SVG viewBox.
const MAP_BUTTON_ZOOM = 1.6;
const DRAG_PICK_THRESHOLD_PX = 4;
const CARD_OUTLINE_PX = 64;
const TWEEN_MS = 420;

function pick(id: string): void {
  const { raceLaps, timeOfDay, rivals, difficulty } = loadSessionSetupPrefs();
  saveSessionSetupPrefs({ raceLaps, trackId: id, timeOfDay, rivals, difficulty });
}

export function WorldMap() {
  const trackId = useSessionTrackId();
  const land = useMemo(() => landPath(getLandPolygons()), []);
  const [region, setRegion] = useState<MapRegion>("world");
  const [view, setView] = useState<MapView>(() => fullWorldView());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef(view);
  const tweenRef = useRef(0);
  const panRef = useRef<{ startX: number; startY: number; view: MapView } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /** Eases the viewBox to a target instead of snapping. */
  const flyTo = (target: MapView) => {
    cancelAnimationFrame(tweenRef.current);
    const from = viewRef.current;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const t = Math.min(1, (now - start) / TWEEN_MS);
      const e = 1 - (1 - t) ** 3;
      setView({
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        w: from.w + (target.w - from.w) * e,
      });
      if (t < 1) tweenRef.current = requestAnimationFrame(step);
    };
    tweenRef.current = requestAnimationFrame(step);
  };

  useEffect(() => () => cancelAnimationFrame(tweenRef.current), []);

  // Rendered map width: pins and labels are sized in screen pixels, so a
  // phone gets the same ~28px touch target as a desktop.
  const [mapPx, setMapPx] = useState(WORLD_MAP_W);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => setMapPx(Math.max(1, entry.contentRect.width)));
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  // Wheel-zoom about the cursor. Native listener (not React's onWheel) so
  // preventDefault actually suppresses the page scroll.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(tweenRef.current);
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

  const chooseRegion = (next: MapRegion) => {
    setRegion(next);
    flyTo(regionView(TRACKS, next));
  };

  const toSvgDelta = (dxPx: number, dyPx: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return { dx: 0, dy: 0 };
    const unit = view.w / rect.width;
    return { dx: dxPx * unit, dy: dyPx * unit };
  };

  // Map units per screen pixel: pins keep a constant on-screen size at any
  // zoom and any map width.
  const k = view.w / mapPx;
  const zoomedIn = view.w < WORLD_MAP_W / 2.2 && mapPx > 420;
  const visible = region === "world" ? TRACKS : TRACKS.filter((t) => regionOf(t) === region);
  const center = { x: view.x + view.w / 2, y: view.y + (view.w / WORLD_MAP_W) * WORLD_MAP_H / 2 };
  // Label layout in map units (labels are 11px mono text scaled by k):
  // zoomed out only the picked/hovered circuits speak, zoomed in everyone
  // gets a collision-free spot where one exists.
  const priority = [trackId, ...(hoveredId ? [hoveredId] : [])];
  const labels = placeLabels(
    TRACKS.filter((t) => zoomedIn || priority.includes(t.id)).map((t) => ({
      id: t.id,
      text: t.shortName,
      ...projectPin(t.lat, t.lon, WORLD_MAP_W, WORLD_MAP_H),
    })),
    priority,
    7 * k,
    13 * k,
    9 * k
  );

  return (
    <div className={styles.browser}>
      <div className={styles.regions} role="tablist" aria-label="Map region">
        {MAP_REGIONS.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={region === r.id}
            className={region === r.id ? styles.regionActive : styles.region}
            onClick={() => chooseRegion(r.id)}
          >
            {r.label}
            <span className={styles.regionCount}>
              {r.id === "world" ? TRACKS.length : TRACKS.filter((t) => regionOf(t) === r.id).length}
            </span>
          </button>
        ))}
      </div>
      <div className={styles.mapFrame}>
        <svg
          ref={svgRef}
          viewBox={mapViewBox(view)}
          className={styles.map}
          role="radiogroup"
          aria-label="Circuit map"
          onPointerDown={(e) => {
            cancelAnimationFrame(tweenRef.current);
            (e.target as SVGElement).setPointerCapture?.(e.pointerId);
            suppressClickRef.current = false;
            panRef.current = { startX: e.clientX, startY: e.clientY, view };
          }}
          onPointerMove={(e) => {
            const pan = panRef.current;
            if (!pan) return;
            if (Math.hypot(e.clientX - pan.startX, e.clientY - pan.startY) > DRAG_PICK_THRESHOLD_PX) {
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
            const active = t.id === trackId;
            const side = labels.get(t.id);
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
                {/* Generous invisible hit target: 28px across on screen. */}
                <circle r={14} className={styles.pinHit} />
                {active && <circle r={12} className={styles.pinRing} />}
                <circle r={active ? 6.5 : 5} className={active ? styles.pinActive : styles.pinDot} />
                {side && (
                  <text
                    x={side === "right" ? 9 : side === "left" ? -9 : 0}
                    y={side === "above" ? -11 : side === "below" ? 17 : 4}
                    textAnchor={side === "right" ? "start" : side === "left" ? "end" : "middle"}
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
          <button
            type="button"
            className={styles.mapButton}
            aria-label="Zoom in"
            onClick={() => flyTo(zoomMapView(view, center.x, center.y, MAP_BUTTON_ZOOM))}
          >
            +
          </button>
          <button
            type="button"
            className={styles.mapButton}
            aria-label="Zoom out"
            onClick={() => flyTo(zoomMapView(view, center.x, center.y, 1 / MAP_BUTTON_ZOOM))}
          >
            −
          </button>
        </div>
      </div>
      <div className={styles.cards} role="listbox" aria-label="Circuits">
        {visible.map((t) => {
          const active = t.id === trackId;
          const outline = outlinePath(getOutline(t.id).points, CARD_OUTLINE_PX, 6);
          return (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={active}
              onClick={() => pick(t.id)}
              onMouseEnter={() => setHoveredId(t.id)}
              onMouseLeave={() => setHoveredId((id) => (id === t.id ? null : id))}
              className={active ? styles.cardActive : styles.card}
            >
              <svg
                width={CARD_OUTLINE_PX}
                height={CARD_OUTLINE_PX}
                viewBox={`0 0 ${CARD_OUTLINE_PX} ${CARD_OUTLINE_PX}`}
                className={styles.cardOutline}
                aria-hidden="true"
              >
                <path d={outline.d} />
              </svg>
              <span className={styles.cardName}>{t.shortName}</span>
              <span className={styles.cardMeta}>{previewStats(t).length}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
