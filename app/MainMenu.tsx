"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import { loadSeason } from "@/lib/persistence/championship";
import { completedRounds, isSeasonComplete, nextRoundIndex, totalRounds } from "@/lib/race/championship";
import { resolveRosterSelection, parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { useSessionSetupPrefs } from "@/lib/race/sessionSetup";
import { TRACKS, getTrackName } from "@/lib/tracks/registry";
import { MenuNavigator } from "./MenuNavigator";
import { PromptBar } from "./MenuShell";
import { useDriveUrl } from "./useDriveUrl";
import { useIsClient } from "./useIsClient";
import styles from "./menu.module.css";

// The hub's backdrop is the live 3D circuit from the old landing hero. It
// stages three.js, so it mounts client-only.
const HeroCircuit = dynamic(() => import("./HeroCircuit").then((mod) => mod.HeroCircuit), {
  ssr: false,
});

interface Item {
  id: string;
  label: string;
  href: string;
  blurb: string;
}

const ITEMS: Item[] = [
  { id: "quick", label: "QUICK RACE", href: "/race", blurb: "Straight onto the grid with your last setup. A fresh field every time." },
  { id: "gp", label: "GRAND PRIX", href: "/grand-prix", blurb: `Any of ${TRACKS.length} real circuits. Practice, qualifying and race, your rules.` },
  { id: "champ", label: "CHAMPIONSHIP", href: "/championship", blurb: "A full season. Every point counts, every weekend builds the table." },
  { id: "tt", label: "TIME TRIAL", href: "/time-trial", blurb: "One driver, one clock. Chase your ghost and the leaderboard." },
  { id: "mp", label: "MULTIPLAYER", href: "/online", blurb: "Race friends in real time. Open a room, share the code." },
  { id: "garage", label: "GARAGE", href: "/garage", blurb: "Choose your team and driver. It carries into every mode." },
  { id: "settings", label: "SETTINGS", href: "/settings", blurb: "Controls, graphics and your save data." },
];

/**
 * The main menu: the F1 game's hub rather than a scrolling landing page.
 * One column of modes, a detail panel for the focused one, button prompts
 * for keyboard or pad, and the live 3D circuit behind it all.
 */
export function MainMenu() {
  const [focused, setFocused] = useState(0);
  const [pad, setPad] = useState(false);
  const [season, setSeason] = useState<string | null>(null);
  const client = useIsClient();
  const prefs = useSessionSetupPrefs();
  const roster = useRosterSelection();
  const { href: driveHref, go } = useDriveUrl();

  useEffect(() => {
    let cancelled = false;
    loadSeason()
      .then((s) => {
        if (cancelled) return;
        if (!s) setSeason("No season running - start one");
        else if (isSeasonComplete(s)) setSeason("Season complete");
        else {
          const next = nextRoundIndex(s);
          setSeason(`Round ${next + 1} of ${totalRounds(s)} · ${getTrackName(s.rounds[next].trackId)} · ${completedRounds(s)} done`);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const selection = resolveRosterSelection(parseTeamId(roster.teamId), parseDriverCode(roster.driverCode));
  // Live detail lines, only once mounted: they come from this browser's
  // saved prefs, which the server cannot know.
  const detail: Record<string, string | null> = client
    ? {
        quick: `${getTrackName(prefs.trackId)} · ${prefs.raceLaps} laps · ${prefs.rivals + 1} cars`,
        champ: season,
        garage: `${selection.team.name} · ${selection.driver.name}`,
      }
    : {};
  const item = ITEMS[focused];

  return (
    <div className={styles.hub}>
      <div className={styles.hubBackdrop} aria-hidden="true">
        <HeroCircuit />
      </div>
      <div className={styles.hubVeil} aria-hidden="true" />
      <MenuNavigator onPadChange={setPad} />
      <header className={styles.hubHead}>
        <div className={styles.hubLogo}>
          LIFT <span>&amp;</span> COAST
        </div>
        <p className={styles.hubTag}>Save the juice. Send the apex.</p>
      </header>
      <nav className={styles.hubMenu} aria-label="Main menu">
        {ITEMS.map((entry, i) => {
          const common = {
            className: styles.hubItem,
            "data-active": i === focused ? "1" : undefined,
            onFocus: () => setFocused(i),
            onMouseEnter: () => setFocused(i),
          };
          const inner = (
            <>
              <span className={styles.hubIndex}>{String(i + 1).padStart(2, "0")}</span>
              <span className={styles.hubLabel}>{entry.label}</span>
            </>
          );
          return entry.id === "quick" ? (
            <Link key={entry.id} href={client ? driveHref : entry.href} onClick={go} data-nav-default autoFocus {...common}>
              {inner}
            </Link>
          ) : (
            <Link key={entry.id} href={entry.href} {...common}>
              {inner}
            </Link>
          );
        })}
      </nav>
      <aside className={styles.hubDetail} aria-live="polite">
        <div className={styles.hubDetailKicker}>{String(focused + 1).padStart(2, "0")} / {String(ITEMS.length).padStart(2, "0")}</div>
        <div className={styles.hubDetailTitle}>{item.label}</div>
        <p className={styles.hubDetailBlurb}>{item.blurb}</p>
        {detail[item.id] && <p className={styles.hubDetailLive}>{detail[item.id]}</p>}
      </aside>
      <div className={styles.hubLinks}>
        <Link href="/about">About</Link>
        <a href="https://donatr.ee/hussain/" target="_blank" rel="noreferrer">
          Support
        </a>
      </div>
      <PromptBar pad={pad} back={false} />
    </div>
  );
}
