"use client";

import Link from "next/link";
import { useDriveUrl } from "./useDriveUrl";
import styles from "./page.module.css";

// Fixed glass top bar: logomark echoes app/icon.svg (twin red lift slashes
// over a white coast line), anchors jump to the numbered sections, and the
// Drive pill uses the exact same session URL as the setup panel.
const LINKS: Array<[id: string, label: string]> = [
  ["garage", "01 GARAGE"],
  ["circuit", "02 CIRCUIT"],
  ["season", "03 SEASON"],
  ["multiplayer", "04 MULTIPLAYER"],
];

export function TopBar() {
  const { href, go } = useDriveUrl();
  return (
    <header className={styles.topBar}>
      <a href="#top" className={styles.brand}>
        <svg viewBox="0 0 64 64" className={styles.brandMark} aria-hidden="true">
          <path d="M13 39 L27 23 L35 23 L21 39 Z" fill="#e10600" />
          <path d="M27 39 L41 23 L49 23 L35 39 Z" fill="#e10600" opacity="0.6" />
          <rect x="12" y="43" width="40" height="5" rx="2.5" fill="#f5f2ea" />
        </svg>
        <span>
          LIFT<em>&amp;</em>COAST
        </span>
      </a>
      <nav className={styles.topNav} aria-label="Sections">
        {LINKS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>
      <Link href={href} onClick={go} className={styles.topDrive}>
        DRIVE
      </Link>
    </header>
  );
}
