"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import { formatLapTime, type LeaderboardEntry } from "@/lib/race/leaderboard";
import { loadMyTimes } from "@/lib/race/leaderboardClient";
import { getTrackName } from "@/lib/tracks/registry";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  accountsConfigured,
  signIn,
  signOut,
  signUp,
  loadAccountSession,
  saveAccountSession,
  clearAccountSession,
} from "@/lib/race/authClient";
import {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  isValidUsername,
  usernameProblem,
  type AccountSession,
} from "@/lib/race/accounts";

/**
 * The account panel: "New user?" at the foot of the time attack, opening a
 * handle-and-password form for a new account or a returning one.
 *
 * WHAT AN ACCOUNT IS, said plainly because the form would otherwise look like
 * something it is not. A handle and a password, hashed server-side by Supabase
 * Auth and never sent back to the browser. It exists so a returning player can
 * put a lap time under the SAME name from a different device. It is not
 * verified identity - anyone can pick any handle, including one already on the
 * board - so it is never treated as proof of anything, and the copy here says so
 * rather than implying otherwise.
 *
 * IT IS NOT ANTI-CHEAT. A lap time is still submitted by the browser, and the
 * original migration's note on that is unchanged: a client-submitted time
 * cannot be verified server-side without replaying the lap. Signing in proves
 * you are the person who came back, not that you drove the lap.
 *
 * NOTHING HERE BLOCKS DRIVING. Signing in is optional, a failed attempt is one
 * line of copy, and a lap saves identically with or without an account - an
 * anonymous lap still reaches the board.
 *
 * The session is owned here and persisted through the auth client, because the
 * race route reads it back from storage on load and this is the only place on
 * the landing page that holds one.
 */

type Mode = "sign-up" | "sign-in";
type Busy = false | "sign-up" | "sign-in" | "sign-out";

const MY_TIMES_SHOWN = 8;

/** Why a handle is not usable yet, or null when it is fine. */
function usernameHint(raw: string): string | null {
  switch (usernameProblem(raw)) {
    case "too-short":
      return `At least ${MIN_USERNAME_LENGTH} characters.`;
    case "too-long":
      return `At most ${MAX_USERNAME_LENGTH} characters.`;
    case "bad-characters":
      return "Letters, numbers and underscores only.";
    case "must-start-with-letter":
      return "Start with a letter.";
    case "reserved":
      return "That name is reserved.";
    case "empty":
    case null:
      return null;
  }
}

export function TimeAttackAccount() {
  // Restored from storage through a lazy initialiser rather than in an effect:
  // setState directly in an effect body is what react-hooks/set-state-in-effect
  // bans, and the storage read is guarded for SSR anyway. Same pattern as
  // lib/race/roster.ts and the time attack's own name field.
  const [session, setSession] = useState<AccountSession | null>(() => loadAccountSession());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("sign-up");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<Busy>(false);
  const [error, setError] = useState<string | null>(null);
  // One piece of state: the fetched result, TAGGED WITH THE ACCOUNT it belongs
  // to. Everything else about "am I loading" is derived during render from
  // whether that tag still matches, which is the TrackRecords pattern - it
  // keeps the effect free of synchronous state writes AND means signing out
  // mid-flight can never leave one player's times under another's header.
  const [loaded, setLoaded] = useState<{ userId: string; rows: LeaderboardEntry[] } | null>(null);

  const configured = accountsConfigured();
  // A cooldown on attempts, so mashing a button is not a request a frame.
  // Supabase rate-limits server-side too; this is manners.
  const lastAttemptRef = useRef(0);

  /**
   * The single place the session changes, so the state and the stored copy can
   * never disagree. A signed-in lap's access token is refreshed by the race
   * route before it saves (see saveTimeAttackLap in app/race/Car.tsx), which
   * rewrites the stored session underneath here - and because the stored copy
   * is written by whoever refreshed it, this only has to keep its own changes
   * consistent.
   */
  const applySession = useCallback((next: AccountSession | null) => {
    setSession(next);
    if (next === null) {
      clearAccountSession();
    } else {
      saveAccountSession(next);
    }
  }, []);

  useEffect(() => {
    if (!configured || session === null) return;
    let cancelled = false;
    loadMyTimes(session.userId, 30).then((rows) => {
      if (cancelled) return;
      setLoaded({ userId: session.userId, rows });
    });
    return () => {
      cancelled = true;
    };
  }, [session, configured]);

  // Derived during render, never stored: a stale tag means "no answer for the
  // signed-in player yet", which is the loading state.
  const fresh = session !== null && loaded !== null && loaded.userId === session.userId;
  const times = fresh ? loaded.rows : null;

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      if (busy !== false) return;
      if (!configured) {
        setError("Accounts are unavailable on this build.");
        return;
      }
      if (Date.now() - lastAttemptRef.current < 1500) return;
      lastAttemptRef.current = Date.now();
      setError(null);

      if (mode === "sign-up" && !isValidUsername(username)) {
        setError(usernameHint(username) ?? "Pick a valid handle.");
        return;
      }
      if (mode === "sign-up" && password.length < MIN_PASSWORD_LENGTH) {
        setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }

      setBusy(mode);
      const result =
        mode === "sign-up" ? await signUp(username, password) : await signIn(username, password);
      setBusy(false);

      if (!result.ok || result.session === null) {
        setError(result.message ?? "Something went wrong.");
        return;
      }
      // The password has done its one job; it is not left in a field or in
      // state where anything could read it back out.
      setPassword("");
      applySession(result.session);
      setOpen(false);
    },
    [busy, configured, mode, username, password, applySession]
  );

  const doSignOut = useCallback(() => {
    if (busy !== false) return;
    setBusy("sign-out");
    if (session !== null) {
      // Fire and forget: a player on a plane must still be able to sign out,
      // and a stranded token expires by itself.
      void signOut(session);
    }
    applySession(null);
    setPassword("");
    setOpen(false);
    setBusy(false);
  }, [busy, session, applySession]);

  // A build with no project cannot sign anyone up, so there is no form worth
  // showing - but it says so rather than vanishing. This used to return null,
  // and the result was a deployed build missing its Supabase variables looking
  // exactly like a build where the feature was never implemented: the sign-up
  // was simply not there, with nothing to say why. One line is the difference
  // between a diagnosable deployment and a mystery.
  if (!configured) {
    return (
      <div className={styles.account} data-testid="time-attack-account">
        <p className={styles.accountNote}>
          Accounts are unavailable on this build - it has no lap-time board
          configured. Laps are still timed and shown above.
        </p>
      </div>
    );
  }

  if (session !== null) {
    return (
      <div className={styles.account} data-testid="time-attack-account">
        <div className={styles.accountSignedIn}>
          <span className={styles.accountWho}>
            Laps saved as <b>{session.username}</b>
          </span>
          <button type="button" className={styles.accountLink} onClick={doSignOut} disabled={busy !== false}>
            Sign out
          </button>
        </div>
        <div className={styles.accountTimes}>
          {times === null ? (
            <p className={styles.recordsNote}>Loading your times…</p>
          ) : times.length === 0 ? (
            <p className={styles.recordsNote}>Your times appear here once you set a lap.</p>
          ) : (
            <ul className={styles.accountTimeList}>
              {bestPerTrack(times).slice(0, MY_TIMES_SHOWN).map((entry) => (
                <li key={entry.trackId} className={styles.accountTimeRow}>
                  <span className={styles.accountTimeCircuit}>{getTrackName(entry.trackId)}</span>
                  <span className={styles.accountTimeValue}>{formatLapTime(entry.lapMs) ?? "--"}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.account} data-testid="time-attack-account">
      {!open ? (
        <button
          type="button"
          className={styles.accountPrompt}
          onClick={() => {
            setError(null);
            setOpen(true);
          }}
        >
          New user? Keep your times
        </button>
      ) : (
        <form className={styles.accountForm} onSubmit={submit}>
          <div className={styles.accountTabs} role="tablist" aria-label="Account">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-up"}
              className={mode === "sign-up" ? styles.accountTabActive : styles.accountTab}
              onClick={() => {
                setMode("sign-up");
                setError(null);
              }}
            >
              New user
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "sign-in"}
              className={mode === "sign-in" ? styles.accountTabActive : styles.accountTab}
              onClick={() => {
                setMode("sign-in");
                setError(null);
              }}
            >
              Sign in
            </button>
          </div>

          <label className={styles.accountField}>
            <span className={styles.accountLabel}>Username</span>
            <input
              className={styles.accountInput}
              type="text"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={MAX_USERNAME_LENGTH}
              onChange={(e) => {
                setUsername(e.target.value);
                setError(null);
              }}
            />
          </label>

          <label className={styles.accountField}>
            <span className={styles.accountLabel}>Password</span>
            <input
              className={styles.accountInput}
              type="password"
              value={password}
              autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
              maxLength={MAX_PASSWORD_LENGTH}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
          </label>

          {mode === "sign-up" && (
            <p className={styles.accountHint}>
              {usernameHint(username) ??
                `${MIN_USERNAME_LENGTH}-${MAX_USERNAME_LENGTH} letters, numbers or underscores.`}
            </p>
          )}

          {error !== null && (
            <p className={styles.accountError} role="alert">
              {error}
            </p>
          )}

          <div className={styles.accountActions}>
            <button type="submit" className={styles.accountSubmit} disabled={busy !== false}>
              {busy !== false ? "Working…" : mode === "sign-up" ? "Create account" : "Sign in"}
            </button>
            <button
              type="button"
              className={styles.accountLink}
              onClick={() => {
                setOpen(false);
                setError(null);
                setPassword("");
              }}
            >
              Cancel
            </button>
          </div>

          <p className={styles.accountNote}>
            {mode === "sign-up"
              ? "A handle and a password, so your times are yours on any device. Anyone can pick any handle, so it is a nickname, not a verified identity."
              : "Welcome back. Your laps will be saved under your handle."}
          </p>
        </form>
      )}
    </div>
  );
}

/**
 * Fastest lap per circuit. The read is already ordered fastest-first, so this
 * is a first-seen-wins pass - and it is what "your times" means to a player:
 * one number per circuit, not a list of every attempt.
 */
function bestPerTrack(entries: readonly LeaderboardEntry[]): LeaderboardEntry[] {
  const seen = new Set<string>();
  const best: LeaderboardEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.trackId)) continue;
    seen.add(entry.trackId);
    best.push(entry);
  }
  return best;
}
