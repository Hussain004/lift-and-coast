// Flashback allowance per AI level, as in the F1 game: the easier the
// opposition, the more second chances. Null = unlimited.
import type { AIDifficulty } from "../ai/personalities";

export const FLASHBACKS_BY_DIFFICULTY: Record<AIDifficulty, number | null> = {
  rookie: null,
  club: 5,
  pro: 3,
  ace: 1,
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
