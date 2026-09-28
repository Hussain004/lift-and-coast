import type { Metadata } from "next";
import { ControlSettingsPanel } from "../../race/ControlSettingsPanel";
import { SaveTransfer } from "../../SaveTransfer";
import { GraphicsSetting } from "../../GraphicsSetting";
import { EngineerSetting } from "../../EngineerSetting";
import { CameraSetting } from "../../CameraSetting";
import { HapticsSetting } from "../../HapticsSetting";
import { AudioSetting } from "../../AudioSetting";
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
          <h2 className={styles.cardTitle} style={{ marginTop: 18 }}>CAMERA</h2>
          <p className={styles.cardNote}>Kerb and high-speed shake. Off by default if your system asks for reduced motion.</p>
          <CameraSetting />
          <h2 className={styles.cardTitle} style={{ marginTop: 18 }}>VIBRATION</h2>
          <p className={styles.cardNote}>Gamepad rumble on kerbs, slides and impacts (Chromium browsers), and phone vibration on impacts.</p>
          <HapticsSetting />
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>SOUND</h2>
          <p className={styles.cardNote}>Engines, effects and menu sounds. M toggles it during a race.</p>
          <AudioSetting />
        </section>
        <section className={styles.card}>
          <h2 className={styles.cardTitle}>RACE ENGINEER</h2>
          <p className={styles.cardNote}>Radio calls on gaps, tyres, fuel, damage and the flag. Voice uses your browser&apos;s speech and respects mute (M).</p>
          <EngineerSetting />
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
