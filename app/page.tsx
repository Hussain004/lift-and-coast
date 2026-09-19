import { Championship } from "./Championship";
import { SaveTransfer } from "./SaveTransfer";
import { SessionSetup } from "./SessionSetup";
import { TeamSetup } from "./TeamSetup";
import { WorldMap } from "./WorldMap";
import { ShowroomLoader } from "./ShowroomLoader";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <div className={styles.backdrop} aria-hidden="true">
        <div className={styles.orbA} />
        <div className={styles.orbB} />
        <div className={styles.orbC} />
      </div>
      <header className={styles.hero}>
        <p className={styles.kicker}>2026 regulation era · browser formula racing</p>
        <h1 className={styles.title}>
          LIFT <span>&</span> COAST
        </h1>
        <p className={styles.tagline}>Save the juice. Send the apex.</p>
      </header>
      <div className={styles.section}>
        <p className={styles.eyebrow}>
          <b>01</b> GARAGE
        </p>
        <div className={styles.garage}>
          <ShowroomLoader />
          <TeamSetup />
        </div>
      </div>
      <div className={styles.section}>
        <p className={styles.eyebrow}>
          <b>02</b> CIRCUIT
        </p>
        <div className={styles.planner}>
          <WorldMap />
          <SessionSetup />
        </div>
      </div>
      <div className={styles.section}>
        <p className={styles.eyebrow}>
          <b>03</b> SEASON
        </p>
        <Championship />
      </div>
      <p className={styles.tip}>
        Lift &amp; coast: it&apos;s not slow, it&apos;s strategic.
      </p>
      <SaveTransfer />
    </div>
  );
}
