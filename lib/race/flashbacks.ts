// Flashback allowance per AI level. Null = unlimited. The F1 game rations
// these by difficulty (Rookie unlimited, Club 5, Pro 3, Ace 1); here they are
// all unlimited on purpose - the limits are one line each if they come back.
import type { AIDifficulty } from "../ai/personalities";

export const FLASHBACKS_BY_DIFFICULTY: Record<AIDifficulty, number | null> = {
  rookie: null,
  club: null,
  pro: null,
  ace: null,
};

/** Races only: practice, qualifying and time trial rewind freely. */
export function flashbackLimit(difficulty: AIDifficulty, sessionMode: string): number | null {
  return sessionMode === "race" ? FLASHBACKS_BY_DIFFICULTY[difficulty] : null;
}

/** A hold shorter than this is a mis-tap, not a used flashback. */
export const MIN_FLASHBACK_SECONDS = 0.5;

export function flashbackLabel(left: number | null): string {
  return left === null ? "UNLIMITED" : `${left} LEFT`;
}
