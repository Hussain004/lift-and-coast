// Plan section 8 (Game Flow & Screens): Team Select and Driver Select - the
// 2026-season roster (see data/teams.json: team and driver names, FIA codes
// and race numbers; livery colors are trackside approximations, not factory
// paint codes) and the player's pick from it.
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
//
// Server-safe half of the roster module: pure data and validation only, no
// React, so server components (the home page ticker counts) can import it.
// The hook and storage live in ./roster (client).
import teamsData from "../../data/teams.json";

export interface RosterDriver {
  code: string;
  name: string;
  number: number;
  /** Stylized helmet livery for the showroom figure - team-adjacent colors,
   * not a replica of the real design. */
  helmet: string;
  visor: string;
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
