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

  return (
    <div className={styles.wrap}>
      <Scene speedRef={speedRef} lapRef={lapRef} />
      <div className={styles.hud}>WASD / arrows to drive. Hold R to rewind.</div>
      <div className={styles.lap} ref={lapRef}>
        LAP 1 --:--.---  BEST --:--.---
      </div>
      <div className={styles.speed} ref={speedRef}>
        0 km/h
      </div>
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
