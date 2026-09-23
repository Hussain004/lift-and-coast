"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent } from "react";
import {
  buildRaceUrl,
  useSessionSetupPrefs,
  type SessionMode,
} from "@/lib/race/sessionSetup";
import { parseDriverCode, parseTeamId, useRosterSelection } from "@/lib/race/roster";
import { parseTrackId } from "@/lib/tracks/registry";

// The hero/top-bar Drive link: same URL contract as the session-setup panel
// (app/SessionSetup.tsx) so every Drive on the page agrees - current garage
// pick, circuit, laps, rivals, difficulty and lighting, carried explicitly
// (see lib/race/sessionSetup.ts). Plain left clicks deal a fresh random
// grid via the router (?seed=); modified clicks follow the seedless href.
// Module scope so the React compiler never sees Math.random during
// render - this only ever runs from a click handler.
function randomSeed(): number {
  return (Math.random() * 2 ** 31) | 0;
}

export function useDriveUrl() {
  const prefs = useSessionSetupPrefs();
  const { teamId, driverCode } = useRosterSelection();
  const router = useRouter();

  const base = {
    mode: "race" as SessionMode,
    track: parseTrackId(prefs.trackId),
    laps: prefs.raceLaps,
    team: parseTeamId(teamId),
    driver: parseDriverCode(driverCode),
    tod: prefs.timeOfDay,
    weather: prefs.weather,
    rivals: prefs.rivals,
    difficulty: prefs.difficulty,
  };

  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(buildRaceUrl({ ...base, seed: randomSeed() }));
  };

  return { href: buildRaceUrl(base), go };
}
