"use client";

// Client half of the roster module: storage-backed prefs and the live
// selection hook. Pure data and validation live in ./rosterData (server
// safe); everything here needs a browser. Re-exported so existing
// importers keep working unchanged.
import { useEffect, useState } from "react";

export * from "./rosterData";
import { DEFAULT_DRIVER_CODE, DEFAULT_TEAM_ID, parseDriverCode, parseTeamId } from "./rosterData";
import { resolveRosterSelection } from "./rosterData";

// localStorage-backed "last selections" (plan section 10: localStorage is
// for settings/state like this), following lib/race/sessionSetup.ts: storage
// is injected so the logic is unit-testable without a DOM, and the default
// falls back to a guarded global so SSR just gets the default prefs.
const ROSTER_KEY = "lift-and-coast.roster.v1";

export interface RosterPrefs {
  teamId: string;
  driverCode: string;
}

/** Fired on window whenever saveRosterPrefs persists, so every setup panel
 * on the page re-reads the same selection without prop drilling. */
export const ROSTER_CHANGE_EVENT = "lift-and-coast:roster-change";

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function clampPrefs(raw: { teamId?: unknown; driverCode?: unknown }): RosterPrefs {
  const teamId = typeof raw.teamId === "string" ? parseTeamId(raw.teamId) : DEFAULT_TEAM_ID;
  const driverCode =
    typeof raw.driverCode === "string" ? parseDriverCode(raw.driverCode) : DEFAULT_DRIVER_CODE;
  const resolved = resolveRosterSelection(teamId, driverCode);
  return { teamId: resolved.team.id, driverCode: resolved.driver.code };
}

export function loadRosterPrefs(
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): RosterPrefs {
  if (!storage) return { teamId: DEFAULT_TEAM_ID, driverCode: DEFAULT_DRIVER_CODE };
  try {
    const raw = storage.getItem(ROSTER_KEY);
    if (!raw) return { teamId: DEFAULT_TEAM_ID, driverCode: DEFAULT_DRIVER_CODE };
    return clampPrefs(JSON.parse(raw) as { teamId?: unknown; driverCode?: unknown });
  } catch {
    return { teamId: DEFAULT_TEAM_ID, driverCode: DEFAULT_DRIVER_CODE };
  }
}

export function saveRosterPrefs(
  prefs: RosterPrefs,
  storage: Pick<Storage, "getItem" | "setItem"> | null = defaultStorage()
): void {
  const clamped = clampPrefs(prefs);
  if (!storage) return;
  try {
    storage.setItem(ROSTER_KEY, JSON.stringify(clamped));
  } catch {
    return;
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(ROSTER_CHANGE_EVENT));
  }
}

/** Live roster selection for setup panels: re-reads whenever any panel
 * persists, so the Drive/Championship links always carry the latest pick. */
export function useRosterSelection(): RosterPrefs {
  const [prefs, setPrefs] = useState<RosterPrefs>(() => loadRosterPrefs());
  useEffect(() => {
    const refresh = () => setPrefs(loadRosterPrefs());
    window.addEventListener(ROSTER_CHANGE_EVENT, refresh);
    return () => window.removeEventListener(ROSTER_CHANGE_EVENT, refresh);
  }, []);
  return prefs;
}
