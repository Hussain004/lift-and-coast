// Which ghost you race (roadmap 11.9: 'Pick "Race: Your PB / Rival (next
// faster time) / World record"').
//
// Kept as a pure function of what is actually available rather than as a
// hardcoded list of three buttons, because two of those three depend on
// storage that does not exist yet. Writing the picker as a static UI would
// have meant shipping a "Rival" button that either does nothing or navigates
// nowhere, and a dead control is worse than an absent one - it advertises a
// feature and then betrays it.
//
// So the option list is DERIVED. An option that cannot be satisfied today is
// still listed, because the player should know it is coming, but it is marked
// unavailable with the reason - and unavailable options are not selectable.
// The day a `ghosts` table exists, the only change needed is a fetch feeding
// `rivalGhost`/`worldRecordGhost` in; this file does not move.

export type GhostChoiceId = "personal-best" | "rival" | "world-record";

export interface GhostCandidate {
  id: GhostChoiceId;
  label: string;
  /** The lap time this ghost set, seconds. Null when unknown. */
  lapSeconds: number | null;
  /** Whose lap it is, for the subtitle ("Your best", a driver code, etc). */
  attribution: string;
  /** True when this option can actually be raced right now. */
  available: boolean;
  /** Why it cannot, when it cannot. Shown to the player verbatim. */
  unavailableReason: string | null;
}

export interface GhostAvailability {
  /** The player's own best lap on this circuit, if they have one. */
  personalBestSeconds: number | null;
  /** A ghost of the next faster time. Null until ghosts can be fetched. */
  rivalGhost: { lapSeconds: number; attribution: string } | null;
  /** The fastest lap on the circuit. Null until ghosts can be fetched. */
  worldRecordGhost: { lapSeconds: number; attribution: string } | null;
}

/**
 * Why the two remote options are unavailable. Stated as player-facing text
 * rather than a generic "coming soon", because the honest reason is specific:
 * there is nowhere to store a shared ghost yet, which is a different promise
 * from "we are still building this".
 */
const NO_SHARED_GHOSTS =
  "Shared ghosts need a place to store them - not available yet.";

export function ghostChoices(availability: GhostAvailability): GhostCandidate[] {
  const pb = availability.personalBestSeconds;
  return [
    {
      id: "personal-best",
      label: "Your PB",
      lapSeconds: pb,
      attribution: pb === null ? "No lap set on this circuit yet" : "Your best lap here",
      available: pb !== null,
      unavailableReason: pb === null ? "Set a lap on this circuit first." : null,
    },
    {
      id: "rival",
      label: "Rival",
      lapSeconds: availability.rivalGhost?.lapSeconds ?? null,
      attribution: availability.rivalGhost?.attribution ?? NO_SHARED_GHOSTS,
      available: availability.rivalGhost !== null,
      unavailableReason: availability.rivalGhost === null ? NO_SHARED_GHOSTS : null,
    },
    {
      id: "world-record",
      label: "World record",
      lapSeconds: availability.worldRecordGhost?.lapSeconds ?? null,
      attribution: availability.worldRecordGhost?.attribution ?? NO_SHARED_GHOSTS,
      available: availability.worldRecordGhost !== null,
      unavailableReason: availability.worldRecordGhost === null ? NO_SHARED_GHOSTS : null,
    },
  ];
}

/**
 * Resolves a requested choice to one that can actually be raced.
 *
 * Falls back to the personal best when the request is unavailable, and to null
 * when nothing is. A silent fallback is deliberate: the ghost is an aid, and
 * a player who picked "Rival" and got no ghost at all because storage is not
 * ready would be worse off than one quietly racing their own PB. The UI shows
 * which one is actually loaded, so the fallback is visible rather than secret.
 */
export function resolveGhostChoice(
  choices: GhostCandidate[],
  requested: GhostChoiceId | null
): GhostCandidate | null {
  const usable = choices.filter((c) => c.available);
  if (usable.length === 0) return null;
  const match = usable.find((c) => c.id === requested);
  if (match) return match;
  // Default preference: your own PB is always the most meaningful reference,
  // because it is the one whose sector data the player already understands.
  return usable.find((c) => c.id === "personal-best") ?? usable[0];
}

/** The id to persist, or null when no ghost is loaded. */
export function ghostChoiceStorageValue(choice: GhostCandidate | null): GhostChoiceId | null {
  return choice && choice.available ? choice.id : null;
}
