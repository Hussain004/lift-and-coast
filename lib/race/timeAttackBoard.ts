/**
 * Saving a time-attack lap to the public board.
 *
 * A time attack is an open session with no clock: the player drives until they
 * leave, and every lap that beats their own best is saved. This module owns
 * that one decision - is this lap worth keeping, and what row does it become -
 * and nothing else. The session clock, the lap detection and the validity rule
 * all already exist in the race and are not re-implemented here.
 *
 * WHY A MODULE AND NOT A FEW LINES IN THE CAR. The car component is 1,800
 * lines of per-frame work; the rules that decide what gets written to a public
 * table should be testable without a DOM, a Rapier world or a React tree. What
 * is here is exactly what that needs: "is this an improvement" is arithmetic,
 * and "what row does this lap make" is a pure function of the lap and the
 * identity.
 *
 * BEST-EFFORT BY CONTRACT, exactly as the landing page's own submission is. A
 * board that is unreachable, unconfigured or rate-limited must cost a player
 * nothing but a missing row. Nothing here throws, nothing blocks the lap, and
 * nothing is retried - a failed save is a lost time, not a broken session.
 *
 * WHAT A SAVED LAP IS NOT. Same limit as the original lap_records table: the
 * time was submitted by the browser, so it cannot be verified server-side
 * without replaying the lap. A saved time is a claim, and the account attached
 * to it identifies whose claim it is - not that it is true.
 */

import {
  leaderboardConfigFromEnv,
  submitLap,
  type LeaderboardConfig,
  type LeaderboardTransport,
} from "./leaderboardClient";
import { isSubmittableLap, type LapSubmission } from "./leaderboard";
import { MIN_LAP_SECONDS } from "./lapTimer";
import type { AccountSession } from "./accounts";

/**
 * The compound a time-attack lap is recorded on.
 *
 * The game's fastest - a dry, fresh tyre in dry air - because a time attack is
 * run to find the car's limit and the board should compare like with like. This
 * is the same constant the landing page's own time attack used, and it matches
 * the fastest dry-weather setting in the session setup panel.
 */
export const TIME_ATTACK_COMPOUND = "soft";

/**
 * Whether a completed lap is worth saving to the board.
 *
 * Only an improvement is, and only the first of an equal pair: the driver's
 * personal best is what the board row means, and re-posting the same time
 * every time they match it would fill the table with duplicates and burn
 * through the write rate limit for no gain. `previousBestMs` is the session's
 * best BEFORE this lap, or null when this is their first.
 */
export function isSaveableTimeAttackLap(
  previousBestMs: number | null,
  lapMs: number
): boolean {
  if (!Number.isFinite(lapMs) || lapMs <= 0) return false;
  // Reuses the race's own floor rather than a second copy of it: no circuit in
  // the roster laps faster than this, so anything quicker is a car shuffling
  // over the line rather than a lap.
  if (lapMs < MIN_LAP_SECONDS * 1000) return false;
  return previousBestMs === null || lapMs < previousBestMs;
}

/** The identity a row is filed under. */
export interface TimeAttackIdentity {
  trackId: string;
  driverCode: string;
  teamId: string;
  /** The signed-in player, or null for an anonymous lap. */
  session: AccountSession | null;
}

export interface SubmitTimeAttackOptions extends TimeAttackIdentity {
  lapMs: number;
  knownTrackIds: ReadonlySet<string>;
  /**
   * The per-device id an ANONYMOUS lap is filed under, from
   * `resolveClientId`. Ignored when signed in, where the account id is used
   * instead - that is the whole point of an account, and passing it here would
   * just be a second source of truth for the same column.
   *
   * Passed in rather than read from storage here so this module stays free of
   * the DOM, and so the caller decides what to do when storage is blocked.
   */
  clientId?: string | null;
  transport?: LeaderboardTransport;
  /**
   * Overrides which board the row goes to. Present (even as null) means "use
   * exactly this and do not read the environment", which is what lets a test
   * exercise the real request path without a configured build - the same seam
   * authClient.ts exposes and the same one leaderboardClient.ts has.
   */
  config?: LeaderboardConfig | null;
}

/**
 * The row a saved lap becomes.
 *
 * The driver code is the race's own - already a legal 2-4 character code from
 * the garage - and the handle is the account's when there is one, because that
 * code cannot tell two players apart and the board shows the handle where a
 * row has one. Anonymous is the default and sends no account fields at all, so
 * an unauthenticated save is byte-for-byte the request that has always worked.
 *
 * The client id is the player's own account id when signed in, so the same lap
 * from a different device lands on the same player.
 */
export function timeAttackSubmission(
  options: SubmitTimeAttackOptions
): LapSubmission | null {
  const session = options.session;
  // The account claim and the handle are decided SEPARATELY, because they are
  // separate things. A session whose handle could not be read (see
  // sessionFromAuthResponse) is still a real account, and dropping the claim
  // with it would file the player's lap as anonymous - losing the one piece of
  // attribution they came back for.
  const playerName =
    session !== null && session.username.length > 0 ? session.username : undefined;
  const submission: LapSubmission = {
    trackId: options.trackId,
    lapMs: Math.round(options.lapMs),
    driverCode: options.driverCode,
    teamId: options.teamId,
    compound: TIME_ATTACK_COMPOUND,
    ...(session !== null ? { userId: session.userId } : {}),
    // Omitted rather than sent as an empty string, so the board falls back to
    // the driver code instead of rendering a blank name.
    ...(playerName !== undefined ? { playerName } : {}),
  };
  // The same gate the landing page's submission used, so the two paths cannot
  // drift: a code that cannot be built, an unknown circuit or an impossible
  // time is refused here rather than at the CHECK constraint.
  return isSubmittableLap(submission, options.knownTrackIds) ? submission : null;
}

/**
 * Saves one lap. Resolves true only when the row was actually stored.
 *
 * Never throws: a failure is `false` and costs the player nothing but the
 * save. Called fire-and-forget from the frame loop, so there is no retry and
 * nothing to await - a slow board must not be able to stall the simulation.
 */
export function submitTimeAttackLap(options: SubmitTimeAttackOptions): Promise<boolean> {
  const submission = timeAttackSubmission(options);
  if (submission === null) return Promise.resolve(false);
  const config =
    options.config !== undefined
      ? options.config
      : leaderboardConfigFromEnv({
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        });
  const session = options.session;
  // Signed in: the row carries the account, and the player's own JWT goes out
  // as the bearer so PostgREST can check the claimed id against auth.uid().
  // Signed out: no token, the publishable key, anonymous row - unchanged.
  return submitLap(
    config,
    submission,
    session !== null ? session.userId : options.clientId ?? null,
    options.knownTrackIds,
    options.transport ?? {},
    session?.accessToken
  );
}
