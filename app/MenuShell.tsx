"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { MenuNavigator } from "./MenuNavigator";
import pageStyles from "./page.module.css";
import styles from "./menu.module.css";

const TITLES: Record<string, string> = {
  "/grand-prix": "GRAND PRIX",
  "/championship": "CHAMPIONSHIP",
  "/time-trial": "TIME TRIAL",
  "/online": "MULTIPLAYER",
  "/garage": "GARAGE",
  "/settings": "SETTINGS",
};

/**
 * Chrome for every menu screen: a top bar with the way back and the screen
 * title, the input-aware button-prompt footer, and console-style spatial
 * navigation (arrows / D-pad, Enter / A, Esc / B).
 */
export function MenuShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [pad, setPad] = useState(false);
  const title = TITLES[pathname] ?? "";
  return (
    <div className={`${pageStyles.page} ${styles.shell}`}>
      <MenuNavigator backHref="/" onPadChange={setPad} />
      <header className={styles.bar}>
        <Link href="/" className={styles.back} aria-label="Back to main menu">
          <span aria-hidden="true">‹</span> MENU
        </Link>
        <h1 className={styles.title}>{title}</h1>
        <Link href="/" className={styles.brand} tabIndex={-1}>
          LIFT<em>&amp;</em>COAST
        </Link>
      </header>
      <main className={styles.content}>{children}</main>
      <PromptBar pad={pad} back />
    </div>
  );
}

/** Button prompts for whichever input is in use, like a console game. */
export function PromptBar({ pad, back }: { pad: boolean; back: boolean }) {
  return (
    <footer className={styles.prompts} aria-hidden="true">
      {pad ? (
        <>
          <span><kbd>✚</kbd> NAVIGATE</span>
          <span><kbd className={styles.padA}>A</kbd> SELECT</span>
          {back && <span><kbd className={styles.padB}>B</kbd> BACK</span>}
        </>
      ) : (
        <>
          <span><kbd>↑↓←→</kbd> NAVIGATE</span>
          <span><kbd>ENTER</kbd> SELECT</span>
          {back && <span><kbd>ESC</kbd> BACK</span>}
        </>
      )}
    </footer>
  );
}
