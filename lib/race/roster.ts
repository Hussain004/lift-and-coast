// Plan section 8 (Game Flow & Screens): Team Select and Driver Select - the
// fictional roster (see data/teams.json) and the player's pick from it.
// Deliberately identity-only: teams carry livery colors and drivers carry
// names/codes/numbers, but there are NO performance stats anywhere here.
// The plan's "card stats feed AI personalities" is not implemented on
// purpose - anything that perturbs the shared AI controller proved
// chaotically sensitive (see the lookahead and boost comments in
// lib/ai/pathFollower.ts), and AI difficulty tiers are blocked for the same
// reason (see app/SessionSetup.tsx). A stat with no effect would be dead
// config, so the roster carries none: picking a team paints your car and
// picks your teammate-opponent, nothing more.
//
// Two-car field (see lib/race/championship.ts): the AI opponent is always
// the player's teammate - the other driver on the same team - so the team
// pick is what dresses both cars on the grid. The player runs the primary
// livery, the teammate the secondary, which keeps the two boxes
// distinguishable the way helmet/number differences do for real teammates.
import { useEffect, useState } from "react";
import teamsData from "../../data/teams.json";

export interface RosterDriver {
  code: string;
  name: string;
  number: number;
}

export interface RosterTeam {
  id: string;
  name: string;
  primaryColor: string;
  secondaryColor: string;
  drivers: RosterDriver[];
}

export const TEAMS: RosterTeam[] = (teamsData as { teams: RosterTeam[] }).teams;

export const DEFAULT_TEAM_ID = TEAMS[0].id;
export const DEFAULT_DRIVER_CODE = TEAMS[0].drivers[0].code;

export function isKnownTeamId(id: string): boolean {
  return TEAMS.some((t) => t.id === id);
}

export function isKnownDriverCode(code: string): boolean {
  return TEAMS.some((t) => t.drivers.some((d) => d.code === code));
}

/**
 * Resolves a `?team=` URL value to a known team id - unknown/missing values
 * fall back to the default instead of throwing, so a stale or hand-edited
 * link can't white-screen the race (same contract as parseTrackId).
 */
export function parseTeamId(raw: string | null): string {
  return raw !== null && isKnownTeamId(raw) ? raw : DEFAULT_TEAM_ID;
}

/** Same unknown-tolerant contract as parseTeamId, for `?driver=`. */
export function parseDriverCode(raw: string | null): string {
  return raw !== null && isKnownDriverCode(raw) ? raw : DEFAULT_DRIVER_CODE;
}

export interface RosterSelection {
  team: RosterTeam;
  /** The player's driver - always a member of `team`. */
  driver: RosterDriver;
  /** The AI opponent: the other driver on the same team. */
  teammate: RosterDriver;
}

/**
 * Resolves a (team, driver) pair to a validated selection. A driver code
 * from another team (e.g. a stale saved pick from before a team switch)
 * resolves to that team's first driver rather than mixing teams - the
 * opponent is defined as the teammate, so cross-team pairs are meaningless.
 */
export function resolveRosterSelection(teamId: string, driverCode: string): RosterSelection {
  const team = TEAMS.find((t) => t.id === teamId) ?? TEAMS[0];
  const driver = team.drivers.find((d) => d.code === driverCode) ?? team.drivers[0];
  const teammate = team.drivers.find((d) => d.code !== driver.code) ?? team.drivers[0];
  return { team, driver, teammate };
}

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
