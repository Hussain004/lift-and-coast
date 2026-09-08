import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>
        LIFT <span>&</span> COAST
      </h1>
      <p className={styles.tagline}>Save the juice. Send the apex.</p>
      <Link href="/race" className={styles.play}>
        Drive
      </Link>
      <p className={styles.tip}>
        Lift &amp; coast: it&apos;s not slow, it&apos;s strategic.
      </p>
    </div>
  );
}
