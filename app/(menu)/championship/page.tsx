import type { Metadata } from "next";
import { Championship } from "../../Championship";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Championship · LIFT & COAST" };

export default function ChampionshipPage() {
  return (
    <div className={styles.narrow}>
      <p className={styles.lede}>A season across the calendar: practice, qualify, race, score.</p>
      <Championship />
    </div>
  );
}
