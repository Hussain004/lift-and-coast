import type { Metadata } from "next";
import { TimeAttack } from "../../TimeAttack";
import { TrackRecords } from "../../TrackRecords";
import { WorldMap } from "../../WorldMap";
import pageStyles from "../../page.module.css";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Time Trial · LIFT & COAST" };

export default function TimeTrialPage() {
  return (
    <>
      <p className={styles.lede}>Just you, the clock and the circuit. Every lap that beats your best goes on the board.</p>
      <div className={pageStyles.planner}>
        <WorldMap />
        <div className={styles.stack}>
          <TimeAttack />
          <TrackRecords />
        </div>
      </div>
    </>
  );
}
