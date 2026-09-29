"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CONTROL_ACTIONS,
  CONTROL_LABELS,
  formatKeyCode,
  getBindings,
  subscribeToControls,
} from "@/lib/input/keyBindings";
import { ControlSettingsPanel } from "../ControlSettingsPanel";
import { EngineerSetting } from "../../EngineerSetting";
import { CameraSetting } from "../../CameraSetting";
import { RacingLineSetting } from "../../RacingLineSetting";
import styles from "./hud.module.css";

/** Keys that are not rebindable, so they are not in the bindings table. */
const FIXED_KEYS: [string, string][] = [
  ["P / Esc", "Pause menu"],
  ["Tab", "Full timing tower"],
  [", / .", "Wheel display page"],
  ["1-4, 6", "Tyre: soft, medium, hard, inter, wet"],
  ["H", "Race Ops / telemetry panel"],
  ["0", "Telemetry"],
  ["N", "Mirrors (cockpit cams)"],
  ["M", "Mute"],
  ["K", "Graphics quality"],
  ["F", "FPS meter"],
];

type View = "menu" | "controls" | "settings";

/**
 * Full pause menu (the old one was a card with a Resume button): resume,
 * restart, the live control map, settings, and the way out. Up/Down and
 * Enter work, as does the mouse.
 */
export function PauseMenu({
  trackName,
  sessionLabel,
  online,
  onResume,
  onRestart,
  onPhoto,
}: {
  trackName: string;
  sessionLabel: string;
  /** Online the race keeps running underneath, and restart is not ours. */
  online: boolean;
  onResume: () => void;
  onRestart: () => void;
  /** Enter photo mode (singleplayer only). */
  onPhoto?: () => void;
}) {
  const [view, setView] = useState<View>("menu");
  const [confirm, setConfirm] = useState<"restart" | null>(null);
  const bindings = useSyncExternalStore(subscribeToControls, getBindings, getBindings);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("button, a")?.focus();
  }, [view, confirm]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape" && view !== "menu") {
        e.stopImmediatePropagation();
        setView("menu");
        return;
      }
      if (e.code !== "ArrowDown" && e.code !== "ArrowUp") return;
      const items = [...(listRef.current?.querySelectorAll<HTMLElement>("button, a") ?? [])];
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = (at + (e.code === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [view]);

  return (
    <div className={styles.pauseOverlay} role="dialog" aria-label="Pause menu">
      <div className={styles.pause}>
        <div className={styles.pauseSide}>
          <div className={styles.resultsKicker}>{online ? "MENU · RACE CONTINUES" : "PAUSED"}</div>
          <div className={styles.pauseTitle}>{trackName}</div>
          <div className={styles.resultsSub}>{sessionLabel}</div>
          <div className={styles.pauseList} ref={view === "menu" ? listRef : undefined}>
            {view === "menu" && confirm === null && (
              <>
                <button type="button" className={styles.pauseItem} onClick={onResume}>
                  RESUME
                </button>
                {!online && (
                  <button type="button" className={styles.pauseItem} onClick={() => setConfirm("restart")}>
                    RESTART SESSION
                  </button>
                )}
                {onPhoto && (
                  <button type="button" className={styles.pauseItem} onClick={onPhoto}>
                    PHOTO MODE
                  </button>
                )}
                <button type="button" className={styles.pauseItem} onClick={() => setView("controls")}>
                  CONTROLS
                </button>
                <button type="button" className={styles.pauseItem} onClick={() => setView("settings")}>
                  SETTINGS
                </button>
                <Link className={styles.pauseItem} href="/">
                  QUIT TO MENU
                </Link>
              </>
            )}
            {view === "menu" && confirm === "restart" && (
              <>
                <p className={styles.pauseConfirm}>Restart from the grid? This session&apos;s progress is lost.</p>
                <button type="button" className={styles.pauseItem} onClick={onRestart}>
                  YES, RESTART
                </button>
                <button type="button" className={styles.pauseItem} onClick={() => setConfirm(null)}>
                  CANCEL
                </button>
              </>
            )}
          </div>
        </div>
        {view !== "menu" && (
          <div className={styles.pauseMain} ref={listRef}>
            <div className={styles.pauseMainHead}>
              <span>{view === "controls" ? "CONTROLS" : "SETTINGS"}</span>
              <button type="button" className={styles.ghostButton} onClick={() => setView("menu")}>
                BACK · ESC
              </button>
            </div>
            {view === "controls" ? (
              <dl className={styles.keyList}>
                {CONTROL_ACTIONS.map((action) => (
                  <div key={action}>
                    <dt>{CONTROL_LABELS[action]}</dt>
                    <dd>{bindings[action].map(formatKeyCode).join(" / ")}</dd>
                  </div>
                ))}
                {FIXED_KEYS.map(([keys, label]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{keys}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <>
                <div className={styles.pauseSubhead}>RACE ENGINEER</div>
                <EngineerSetting />
                <div className={styles.pauseSubhead}>RACING LINE</div>
                <RacingLineSetting />
                <div className={styles.pauseSubhead}>CAMERA</div>
                <CameraSetting />
                <div className={styles.pauseSubhead}>CONTROLS</div>
                <ControlSettingsPanel inline />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
