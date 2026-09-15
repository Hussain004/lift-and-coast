"use client";

import dynamic from "next/dynamic";
import { useRef } from "react";
import styles from "./race.module.css";

const Scene = dynamic(() => import("./Scene").then((mod) => mod.Scene), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading track...</div>,
});

export default function RacePage() {
  const speedRef = useRef<HTMLDivElement>(null);
  const lapRef = useRef<HTMLDivElement>(null);
  const deltaRef = useRef<HTMLDivElement>(null);
  const sectorsRef = useRef<HTMLDivElement>(null);
  const trackLimitRef = useRef<HTMLDivElement>(null);
  const energyRef = useRef<HTMLDivElement>(null);
  const aeroModeRef = useRef<HTMLDivElement>(null);
  const tireRef = useRef<HTMLDivElement>(null);

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
      />
      <div className={styles.hud}>
        WASD / arrows to drive. Hold R to rewind. Hold Shift to deploy. Press
        E to toggle aero mode. Press C to toggle camera. Press 1/2/3 for
        soft/medium/hard tires.
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
      <div className={styles.trackLimit} ref={trackLimitRef} />
      <div className={styles.energyTrack}>
        <div className={styles.energyFill} ref={energyRef} />
      </div>
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
