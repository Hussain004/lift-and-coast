import type { Metadata } from "next";
import { SessionSetup } from "../../SessionSetup";
import { TrackRecords } from "../../TrackRecords";
import { WorldMap } from "../../WorldMap";
import pageStyles from "../../page.module.css";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Grand Prix · LIFT & COAST" };

export default function GrandPrixPage() {
  return (
    <>
      <p className={styles.lede}>Pick a circuit, set up the weekend, and take on a full grid.</p>
      <div className={pageStyles.planner}>
        <WorldMap />
        <SessionSetup />
      </div>
      <TrackRecords />
    </>
  );
}
