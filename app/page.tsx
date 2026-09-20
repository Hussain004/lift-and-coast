import { Championship } from "./Championship";
import { Multiplayer } from "./Multiplayer";
import { SaveTransfer } from "./SaveTransfer";
import { SessionSetup } from "./SessionSetup";
import { TeamSetup } from "./TeamSetup";
import { WorldMap } from "./WorldMap";
import { ShowroomLoader } from "./ShowroomLoader";
import { Hero } from "./Hero";
import { TopBar } from "./TopBar";
import { Reveal } from "./Reveal";
import { TRACKS } from "@/lib/tracks/registry";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page} id="top">
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.orbA} />
        <div className={styles.orbB} />
        <div className={styles.orbC} />
      </div>
      <TopBar />
      <Hero />
      <main className={styles.main}>
        <section className={styles.section} id="garage">
          <Reveal>
            <p className={styles.eyebrow}>
              <b>01</b> GARAGE
            </p>
          </Reveal>
          <Reveal delay={90}>
            <div className={styles.garage}>
              <ShowroomLoader />
              <TeamSetup />
            </div>
          </Reveal>
        </section>
        <section className={styles.section} id="circuit">
          <Reveal>
            <p className={styles.eyebrow}>
              <b>02</b> CIRCUIT
            </p>
          </Reveal>
          <Reveal delay={90}>
            <div className={styles.planner}>
              <WorldMap />
              <SessionSetup />
            </div>
          </Reveal>
        </section>
        <div className={styles.duo}>
          <section className={styles.section} id="season">
            <Reveal>
              <p className={styles.eyebrow}>
                <b>03</b> SEASON
              </p>
            </Reveal>
            <Reveal delay={90} spotlight>
              <Championship />
            </Reveal>
          </section>
          <section className={styles.section} id="multiplayer">
            <Reveal>
              <p className={styles.eyebrow}>
                <b>04</b> MULTIPLAYER
              </p>
            </Reveal>
            <Reveal delay={90} spotlight>
              <Multiplayer />
            </Reveal>
          </section>
        </div>
      </main>
      <footer className={styles.footer}>
        <Reveal>
          <p className={styles.tip}>
            Lift &amp; coast: it&apos;s not slow, it&apos;s strategic.
          </p>
          <SaveTransfer />
          <p className={styles.credit}>
            React Three Fiber · Rapier physics · {TRACKS.length} circuits from real GPS
            centerlines
          </p>
        </Reveal>
      </footer>
    </div>
  );
}

