import type { Metadata } from "next";
import { ControlSettingsPanel } from "../../race/ControlSettingsPanel";
import { SaveTransfer } from "../../SaveTransfer";
import { GraphicsSetting } from "../../GraphicsSetting";
import styles from "../../menu.module.css";

export const metadata: Metadata = { title: "Settings · LIFT & COAST" };

export default function SettingsPage() {
  return (
    <div className={styles.settingsGrid}>
      <section className={styles.card}>
        <h2 className={styles.cardTitle}>CONTROLS</h2>
        <ControlSettingsPanel inline />
      </section>
      <div className={styles.stack}>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>GRAPHICS</h2>
          <GraphicsSetting />
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>SAVE DATA</h2>
          <p className={styles.cardNote}>Your garage, bests, ghosts and season live in this browser. Export a backup or move them to another device.</p>
          <SaveTransfer />
        </section>
      </div>
    </div>
  );
}
