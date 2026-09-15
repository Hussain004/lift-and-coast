"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import styles from "./race.module.css";
import { buildMinimapProjection } from "@/lib/tracks/minimap";
import silverstone from "@/data/tracks/silverstone.json";
import type { TrackData } from "@/lib/tracks/types";

const Scene = dynamic(() => import("./Scene").then((mod) => mod.Scene), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading track...</div>,
});

const MINIMAP_SIZE_PX = 150;
const MINIMAP_PADDING_PX = 10;
// Module-level, not per-render - the track data is static, so the
// projection only needs to be computed once for the whole app lifetime.
const minimapProjection = buildMinimapProjection(
  silverstone as TrackData,
  MINIMAP_SIZE_PX,
  MINIMAP_PADDING_PX
);

export default function RacePage() {
  const speedRef = useRef<HTMLDivElement>(null);
  const lapRef = useRef<HTMLDivElement>(null);
  const deltaRef = useRef<HTMLDivElement>(null);
  const sectorsRef = useRef<HTMLDivElement>(null);
  const trackLimitRef = useRef<HTMLDivElement>(null);
  const energyRef = useRef<HTMLDivElement>(null);
  const aeroModeRef = useRef<HTMLDivElement>(null);
  const tireRef = useRef<HTMLDivElement>(null);
  const assistsRef = useRef<HTMLDivElement>(null);
  const minimapDotRef = useRef<SVGCircleElement>(null);

  return (
    <div className={styles.wrap}>
      <Scene
        speedRef={speedRef}
        lapRef={lapRef}
        deltaRef={deltaRef}
        sectorsRef={sectorsRef}
        trackLimitRef={trackLimitRef}
        energyRef={energyRef}
        aeroModeRef={aeroModeRef}
        tireRef={tireRef}
        assistsRef={assistsRef}
        minimapProjection={minimapProjection}
        minimapDotRef={minimapDotRef}
      />
      <div className={styles.hud}>
        WASD / arrows to drive. Hold R to rewind. Hold Shift to deploy. Press
        E to toggle aero mode. Press C to toggle camera. Press 1/2/3 for
        soft/medium/hard tires. Press T to toggle TC, B to toggle ABS.
      </div>
      <div className={styles.lap} ref={lapRef}>
        LAP 1 --:--.---  BEST --:--.---
      </div>
      <div className={styles.delta} ref={deltaRef} />
      <div className={styles.sectors} ref={sectorsRef} />
      <div className={styles.speed} ref={speedRef}>
        0 km/h
      </div>
      <div className={styles.aeroMode} ref={aeroModeRef} />
      <div className={styles.tire} ref={tireRef} />
      <div className={styles.assists} ref={assistsRef} />
      <div className={styles.trackLimit} ref={trackLimitRef} />
      <svg
        className={styles.minimap}
        width={MINIMAP_SIZE_PX}
        height={MINIMAP_SIZE_PX}
        viewBox={`0 0 ${MINIMAP_SIZE_PX} ${MINIMAP_SIZE_PX}`}
      >
        <path d={minimapProjection.pathD} fill="none" stroke="#fff" strokeWidth={2} />
        <circle
          cx={minimapProjection.startPoint.x}
          cy={minimapProjection.startPoint.y}
          r={3}
          fill="#ffd23f"
        />
        <circle
          ref={minimapDotRef}
          cx={minimapProjection.startPoint.x}
          cy={minimapProjection.startPoint.y}
          r={4}
          fill="#39ff88"
        />
      </svg>
      <div className={styles.energyTrack}>
        <div className={styles.energyFill} ref={energyRef} />
      </div>
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
