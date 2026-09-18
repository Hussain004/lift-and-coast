import { Championship } from "./Championship";
import { SaveTransfer } from "./SaveTransfer";
import { SessionSetup } from "./SessionSetup";
import { TeamSetup } from "./TeamSetup";
import { WorldMap } from "./WorldMap";
import { ShowroomLoader } from "./ShowroomLoader";
import { TEAMS } from "@/lib/race/rosterData";
import { TRACKS } from "@/lib/tracks/registry";
import styles from "./page.module.css";

const DRIVER_COUNT = TEAMS.reduce((n, team) => n + team.drivers.length, 0);
const TICKER_ITEMS = [
  `${TRACKS.length} real-world circuits`,
  `${TEAMS.length} works teams`,
  `${DRIVER_COUNT} grand prix drivers`,
  "Active aero · Push-to-pass",
  "No DRS. Ever.",
  "Real kerbs. Real consequences.",
];

export default function Home() {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.kicker}>2026 regulation era · browser formula racing</p>
        <h1 className={styles.title}>
          LIFT <span>&</span> COAST
        </h1>
        <p className={styles.tagline}>Save the juice. Send the apex.</p>
      </header>
      <ShowroomLoader />
      <div className={styles.ticker} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {[0, 1].map((copy) => (
            <span key={copy} className={styles.tickerCopy}>
              {TICKER_ITEMS.map((item) => (
                <span key={item} className={styles.tickerItem}>
                  {item}
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>
      <TeamSetup />
      <WorldMap />
      <SessionSetup />
      <Championship />
      <p className={styles.tip}>
        Lift &amp; coast: it&apos;s not slow, it&apos;s strategic.
      </p>
      <SaveTransfer />
    </div>
  );
}
