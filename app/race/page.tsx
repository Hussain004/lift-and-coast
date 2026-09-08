"use client";

import dynamic from "next/dynamic";
import styles from "./race.module.css";

const Scene = dynamic(() => import("./Scene").then((mod) => mod.Scene), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading track...</div>,
});

export default function RacePage() {
  return (
    <div className={styles.wrap}>
      <Scene />
      <div className={styles.hud}>WASD / arrows to drive</div>
    </div>
  );
}
