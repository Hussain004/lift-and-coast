// Plan section 8 (Game Flow & Screens): Team Select and Driver Select - the
// 2026-season roster (see data/teams.json: team and driver names, FIA codes
// and race numbers; livery colors are trackside approximations, not factory
// paint codes) and the player's pick from it.
// Deliberately identity-only: teams carry livery colors and drivers carry
// names/codes/numbers, but no performance stats - driver character lives
// in lib/ai/personalities.ts, derived from the code (pace, aggression,
// risk, tire curve), so this module never needs to change when the field's
// driving changes. Picking a team paints your car and picks your
// teammate-opponent, nothing more.
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
import { mulberry32 } from "../ai/personalities";

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

export interface FieldRival {
  code: string;
  name: string;
  number: number;
  teamId: string;
  /** Livery color for the car, tower chip and minimap dot. */
  color: string;
}export interface FieldRoster {
  team: RosterTeam;
  driver: RosterDriver;
  /** Opponents in deterministic roster order, capped at the request. */
  rivals: FieldRival[];
}

/**
 * Plan section 7 (full field): the grid behind a (team, driver, rival
 * count) pick. Every driver except the player's own is a candidate, in
 * roster order (stable across visits, so ?rivals=5 always means the same
 * five cars), capped at the request - with 22 drivers on the roster that
 * fills up to a 20-car grid. Each rival runs its own team's primary
 * livery, the way a real grid dresses per team rather than per player.
 */
export function resolveFieldRoster(
  teamId: string,
  driverCode: string,
  rivalCount: number
): FieldRoster {
  const { team, driver } = resolveRosterSelection(teamId, driverCode);
  const count = Number.isFinite(rivalCount)
    ? Math.max(0, Math.floor(rivalCount))
    : 0;
  const rivals: FieldRival[] = [];
  for (const candidateTeam of TEAMS) {
    for (const candidate of candidateTeam.drivers) {
      if (rivals.length >= count) break;
      if (candidate.code === driver.code) continue;
      rivals.push({
        code: candidate.code,
        name: candidate.name,
        number: candidate.number,
        teamId: candidateTeam.id,
        color: candidateTeam.primaryColor,
      });
    }
    if (rivals.length >= count) break;
  }
  return { team, driver, rivals };
}

/**
 * Parses a ?order= grid (comma-separated FIA codes, pole first): unknown
 * codes, blanks and duplicates reject it (null), so a hand-edited link
 * falls back to the other grid sources instead of dropping cars. Length
 * is checked by the caller against the session's field (see page.tsx) -
 * a stale order from a different-sized grid must not apply either.
 */
export function parseGridOrder(raw: string | null): string[] | null {
  if (raw === null) return null;
  const codes = raw
    .split(",")
    .map((code) => code.trim().toUpperCase())
    .filter((code) => code.length > 0);
  if (codes.length === 0) return null;
  if (new Set(codes).size !== codes.length) return null;
  if (!codes.every(isKnownDriverCode)) return null;
  return codes;
}

/**
 * Random grid order for quick races (see ?seed= in sessionSetup.ts):
 * Fisher-Yates over slot indices with a seeded RNG, so the same seed
 * always deals the same grid (refreshes and shared links reproduce it)
 * while every Drive click deals a fresh one. Pure and unit-tested.
 */
export function shuffledGridOrder(carCount: number, seed: number): number[] {
  const count = Number.isFinite(carCount) ? Math.max(0, Math.floor(carCount)) : 0;
  const order = Array.from({ length: count }, (_, k) => k);
  const rng = mulberry32(seed >>> 0);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

export interface NetGridDriver {
  code: string;
  name: string;
  teamId: string;
  color: string;
}

/**
 * Plan section 16 (online multiplayer): deterministic AI fill for a net
 * grid. Humans (lobby join order, own liveries) take the first slots; the
 * remaining slots go to the first drivers in roster order whose codes no
 * human holds. Pure over the same inputs on host and guest, so both sides
 * dress the same grid without a round-trip - the only shared state is the
 * lobby roster both already have.
 */
export function resolveNetGridRoster(
  humanCodes: readonly string[],
  aiCount: number
): NetGridDriver[] {
  const taken = new Set(humanCodes);
  const fill: NetGridDriver[] = [];
  const want = Number.isFinite(aiCount) ? Math.max(0, Math.floor(aiCount)) : 0;
  for (const candidateTeam of TEAMS) {
    for (const candidate of candidateTeam.drivers) {
      if (fill.length >= want) break;
      if (taken.has(candidate.code)) continue;
      taken.add(candidate.code);
      fill.push({
        code: candidate.code,
        name: candidate.name,
        teamId: candidateTeam.id,
        color: candidateTeam.primaryColor,
      });
    }
    if (fill.length >= want) break;
  }
  return fill;
}
