"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import { buildRaceUrl, useSessionSetupPrefs } from "@/lib/race/sessionSetup";
import { parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { parseTrackId } from "@/lib/tracks/registry";

/**
 * The link that puts the player on the track for a time attack.
 *
 * Same URL contract as every other Drive on the page (see
 * lib/race/sessionSetup.ts and app/useDriveUrl.ts), so the time attack carries
 * the circuit the map above selected and the car the garage picker chose rather
 * than resetting either. The only difference is `ta: 1`, which is what makes
 * the session an open-ended qualifying one whose improved laps are saved.
 *
 * Carried explicitly rather than inheriting the current URL: the garage pick
 * and the circuit are the two things that must agree with what the player is
 * looking at on this page, and reading them from live state is what keeps the
 * button from launching a different session than the one it advertises.
 *
 * Plain left clicks push a fresh URL so the back button works; modified clicks
 * and keyboard activation follow the href, so middle-click, ctrl-click and
 * "open in new tab" all behave like the link they are.
 */
export function useTimeAttackLaunch() {
  const prefs = useSessionSetupPrefs();
  const { teamId, driverCode } = useRosterSelection();
  const router = useRouter();

  const href = buildRaceUrl({
    mode: "qualifying",
    track: parseTrackId(prefs.trackId),
    team: parseTeamId(teamId),
    driver: parseDriverCode(driverCode),
    tod: prefs.timeOfDay,
    weather: prefs.weather,
    timeAttack: true,
  });

  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(href);
  };

  return { href, go };
}
