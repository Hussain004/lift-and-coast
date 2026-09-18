"use client";

import dynamic from "next/dynamic";
import styles from "./page.module.css";

// The 3D garage stages three.js, so it mounts client-only like the race
// canvas (see app/race/page.tsx) - `ssr: false` is not allowed in a Server
// Component, which is why this tiny boundary exists. The fixed-height
// fallback holds layout while it loads.
const ShowroomPanel = dynamic(
  () => import("./Showroom").then((mod) => mod.ShowroomPanel),
  {
    ssr: false,
    loading: () => <div className={styles.showroomFallback} aria-hidden="true" />,
  }
);

export function ShowroomLoader() {
  return (
    <div className={styles.showroom}>
      <ShowroomPanel />
    </div>
  );
}
