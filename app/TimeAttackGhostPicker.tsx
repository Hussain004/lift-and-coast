"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";
import { formatLapTime } from "@/lib/race/leaderboard";
import {
  ghostChoices,
  resolveGhostChoice,
  type GhostCandidate,
  type GhostChoiceId,
} from "@/lib/race/ghostSelection";
import {
  GHOST_CHOICE_EVENT,
  loadGhostChoice,
  saveGhostChoice,
} from "@/lib/race/ghostPrefs";

/**
 * "Race: Your PB / Rival / World record" (roadmap 11.9).
 *
 * The whole point of the derived option list (see ghostSelection.ts) shows up
 * here: two of the three options depend on storage that does not exist yet, so
 * they are rendered as real entries that are visibly unavailable and state
 * WHY, rather than being hidden. A player who cannot see that rival ghosts are
 * coming cannot want them, and a dead button advertising a feature and then
 * doing nothing is worse than an honest one.
 *
 * What is selectable today is the player's own PB, which is already recorded
 * and already replayable - so this is a working control from the first commit,
 * not a placeholder.
 */
export function TimeAttackGhostPicker({
  trackId,
  personalBestSeconds,
}: {
  trackId: string;
  personalBestSeconds: number | null;
}) {
  // The choice is read once on mount and again whenever anything announces a
  // change, rather than mirrored into state on every render.
  const [stored, setStored] = useState<GhostChoiceId | null>(null);
  useEffect(() => {
    const read = () => setStored(loadGhostChoice());
    read();
    window.addEventListener(GHOST_CHOICE_EVENT, read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener(GHOST_CHOICE_EVENT, read);
      window.removeEventListener("storage", read);
    };
  }, []);

  // No shared ghosts can be fetched yet, so those two inputs are absent rather
  // than faked. When a ghosts table exists, this is the only line that changes.
  const choices = useMemo(
    () => ghostChoices({ personalBestSeconds, rivalGhost: null, worldRecordGhost: null }),
    [personalBestSeconds]
  );
  const active = resolveGhostChoice(choices, stored);

  const select = useCallback((choice: GhostCandidate) => {
    if (!choice.available) return;
    saveGhostChoice(choice);
  }, []);

  return (
    <div className={styles.ghostPicker} data-testid="ghost-picker" data-track={trackId}>
      <span className={styles.ghostPickerLabel}>RACE</span>
      <div className={styles.ghostPickerOptions} role="radiogroup" aria-label="Which ghost to race">
        {choices.map((choice) => {
          const selected = active !== null && active.id === choice.id;
          return (
            <button
              key={choice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              // A disabled button explains itself in the tooltip but not on
              // touch, where there is no hover - so the reason is also rendered
              // as text below rather than living only in a title attribute.
              disabled={!choice.available}
              className={styles.ghostPickerOption}
              data-selected={selected ? "1" : "0"}
              data-available={choice.available ? "1" : "0"}
              onClick={() => select(choice)}
            >
              <span className={styles.ghostPickerName}>{choice.label}</span>
              <span className={styles.ghostPickerTime}>
                {choice.lapSeconds === null ? "--" : (formatLapTime(choice.lapSeconds * 1000) ?? "--")}
              </span>
            </button>
          );
        })}
      </div>
      <p className={styles.ghostPickerNote}>
        {active === null
          ? "Set a lap on this circuit to race your own ghost."
          : `Reference: ${active.label} - the delta bar and sector splits compare against it.`}
      </p>
    </div>
  );
}
