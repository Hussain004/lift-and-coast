"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import type { CSSProperties } from "react";
import { MAX_RIVALS } from "@/lib/race/sessionSetup";
import { TRACKS } from "@/lib/tracks/registry";
import { TEAMS } from "@/lib/race/roster";
import { useDriveUrl } from "./useDriveUrl";
import styles from "./page.module.css";

// Full-viewport cinematic hero. The 3D circuit stages three.js, so it
// mounts client-only like the garage showroom (see app/ShowroomLoader.tsx);
// everything else here is server-renderable markup and CSS.
const HeroCircuit = dynamic(
  () => import("./HeroCircuit").then((mod) => mod.HeroCircuit),
  { ssr: false }
);

const CIRCUIT_NAMES = TRACKS.map((t) => t.shortName.toUpperCase());
const DRIVER_COUNT = TEAMS.reduce((n, t) => n + t.drivers.length, 0);

export function Hero() {
  const { href, go } = useDriveUrl();
  return (
    <section className={styles.heroStage} aria-label="Lift and Coast - browser formula racing">
      <HeroCircuit />
      <div className={styles.heroVeil} aria-hidden="true" />
      <div className={styles.heroInner}>
        <div className={styles.startLights} aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} style={{ "--i": i } as CSSProperties} />
          ))}
        </div>
        <p className={styles.kicker}>2026 regulation era · browser formula racing</p>
        <h1 className={styles.title}>
          LIFT <span>&amp;</span> COAST
        </h1>
        <p className={styles.tagline}>Save the juice. Send the apex.</p>
        <div className={styles.heroCtas}>
          <Link href={href} onClick={go} className={styles.driveCta}>
            DRIVE
          </Link>
          <a href="#circuit" className={styles.ghostCta}>
            SCOUT THE CIRCUITS
          </a>
        </div>
        <dl className={styles.heroStats}>
          <div>
            <dt>CIRCUITS</dt>
            <dd>{TRACKS.length}</dd>
          </div>
          <div>
            <dt>TEAMS</dt>
            <dd>{TEAMS.length}</dd>
          </div>
          <div>
            <dt>DRIVERS</dt>
            <dd>{DRIVER_COUNT}</dd>
          </div>
          <div>
            <dt>GRID</dt>
            <dd>{MAX_RIVALS + 1}</dd>
          </div>
        </dl>
      </div>
      <div className={styles.scrollCue} aria-hidden="true">
        <span>SCROLL</span>
        <i />
      </div>
      <div className={styles.ticker} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {[...CIRCUIT_NAMES, ...CIRCUIT_NAMES].map((name, i) => (
            <span key={i} className={styles.tickerItem}>
              {name}
              <b>{"///"}</b>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
