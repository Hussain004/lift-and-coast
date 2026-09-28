"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";
import { useSessionTrackId } from "@/lib/race/sessionSetup";
import { getTrackName } from "@/lib/tracks/registry";
import { formatLapTime, type LeaderboardEntry } from "@/lib/race/leaderboard";
import { leaderboardIsConfigured, loadLeaderboardForTrack } from "@/lib/race/leaderboardClient";
import { useTimeAttackLaunch } from "./useTimeAttackLaunch";
import { TimeAttackAccount } from "./TimeAttackAccount";
import { loadPersonalBest } from "@/lib/persistence/personalBests";

/**
 * The landing page's time attack: a way in, not a driving surface.
 *
 * THIS SECTION LAUNCHES THE SESSION; IT NO LONGER CONTAINS ONE. It used to
 * embed a top-down mini-map and a second, parallel lap-timer driving the same
 * physics through createDriveSession. That was a genuine second implementation
 * of something the race already does properly, and the cost was real - the
 * landing page downloaded a circuit's full centerline plus Rapier's WASM plus
 * three.js, all to draw a small map, and a driver had to work out that the
 * arrow keys were the throttle. What it looked like was never what a lap on
 * this circuit is actually worth.
 *
 * "Set a Lap" now goes to the real thing: the same 3D car, the same physics,
 * the same track limits, on a qualifying session with no clock, where every
 * lap that beats your own best is saved. One lap timer instead of two, one
 * submission path instead of two, and the landing page stays a landing page.
 *
 * WHAT IS STILL HERE: the target to beat. The board for the selected circuit is
 * one click up in the records block, so what this section carries instead is
 * the two numbers that decide whether pressing the button is worth it - the
 * circuit's fastest lap, and the player's own - and then gets out of the way.
 *
 * NOTHING HERE BLOCKS THE LAUNCH. The button is an ordinary link, so it
 * middle-clicks, opens in a new tab and works with the keyboard, and it is
 * always enabled: a circuit with no times on the board is exactly the one
 * worth driving.
 */

const RECORDS_SHOWN = 5;

export function TimeAttack() {
  const trackId = useSessionTrackId();
  const circuit = getTrackName(trackId);
  const { href, go } = useTimeAttackLaunch();
  const configured = leaderboardIsConfigured();

  // The circuit's fastest lap, and the player's own. Both best-effort: an
  // unreachable board or an unavailable IndexedDB leaves the number blank, and
  // a blank is a perfectly good state for "nobody has set a lap here yet".
  //
  // The fetched board is TAGGED WITH ITS CIRCUIT and everything else is derived
  // during render, the TrackRecords pattern - so switching circuits can never
  // leave a frame showing the previous circuit's time, and no effect has to
  // write state to fix it up.
  const [loaded, setLoaded] = useState<{ trackId: string; entries: LeaderboardEntry[] } | null>(null);
  const [ownSeconds, setOwnSeconds] = useState<{ trackId: string; seconds: number } | null>(null);

  useEffect(() => {
    if (configured) {
      let cancelled = false;
      loadLeaderboardForTrack(trackId, RECORDS_SHOWN).then((entries) => {
        if (!cancelled) setLoaded({ trackId, entries });
      });
      return () => {
        cancelled = true;
      };
    }
  }, [trackId, configured]);

  useEffect(() => {
    let cancelled = false;
    // loadPersonalBest never rejects (see personalBests.ts), but a cancelled
    // effect still has to not write state, so the flag is checked anyway.
    loadPersonalBest(trackId).then((record) => {
      if (cancelled || record === null) return;
      setOwnSeconds({ trackId, seconds: record.bestLapSeconds });
    });
    return () => {
      cancelled = true;
    };
  }, [trackId]);

  const fresh = loaded !== null && loaded.trackId === trackId;
  // The board arrives fastest-first (see sortLeaderboard), so the first row is
  // the circuit's fastest lap. 0 is not a real lap time, so it is treated as
  // absent rather than formatted as one.
  const firstLap = fresh && loaded.entries.length > 0 ? loaded.entries[0].lapMs : null;
  const boardBest = firstLap !== null && firstLap > 0 ? firstLap : null;
  const myBest = ownSeconds !== null && ownSeconds.trackId === trackId ? ownSeconds.seconds : null;

  return (
    <div className={styles.timeAttack} data-testid="time-attack">
      <div className={styles.recordsHeader}>
        <span className={styles.recordsEyebrow}>04 &nbsp;TIME ATTACK</span>
        <span className={styles.recordsTrack}>{circuit}</span>
      </div>

      <div className={styles.timeAttackLaunch}>
        <div className={styles.timeAttackLaunchText}>
          <p className={styles.timeAttackLaunchLead}>
            {boardBest === null
              ? "Nobody has set a lap on this circuit yet."
              : "The circuit's fastest lap is set."}
          </p>
          <dl className={styles.timeAttackTargets}>
            <div>
              <dt>CIRCUIT BEST</dt>
              <dd>{boardBest === null ? "--" : (formatLapTime(boardBest) ?? "--")}</dd>
            </div>
            <div>
              <dt>YOUR BEST</dt>
              <dd>{myBest === null ? "--" : (formatLapTime(myBest * 1000) ?? "--")}</dd>
            </div>
          </dl>
        </div>

        <a
          href={href}
          onClick={go}
          className={styles.timeAttackLaunchButton}
        >
          Set a Lap
        </a>

        <p className={styles.recordsNote}>
          Qualifying, with no clock - drive until you leave. Every lap that beats
          your own best is saved to the board above.
        </p>
      </div>

      <TimeAttackAccount />
    </div>
  );
}
