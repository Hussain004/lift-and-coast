import { Championship } from "./Championship";
import { SaveTransfer } from "./SaveTransfer";
import { SessionSetup } from "./SessionSetup";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>
        LIFT <span>&</span> COAST
      </h1>
      <p className={styles.tagline}>Save the juice. Send the apex.</p>
      <SessionSetup />
      <Championship />
      <p className={styles.tip}>
        Lift &amp; coast: it&apos;s not slow, it&apos;s strategic.
      </p>
      <SaveTransfer />
    </div>
  );
}
