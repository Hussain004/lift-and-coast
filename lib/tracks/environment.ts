/**
 * Small, data-only circuit environment table shared by the terrain mesh,
 * surface classifier, flora placement, and barrier generator.
 *
 * Track geometry tells us where the ribbon is, but not what the runoff
 * around it is made from. Keeping that choice here prevents the visual
 * ground from saying "grass" while the physics classifier calls the same
 * corner a gravel trap, and gives newly added circuits a sensible default.
 */

export type RunoffKind = "grass" | "paved" | "gravel";

const RUNOFF_BY_TRACK: Record<string, RunoffKind> = {
  // Temporary street layouts use asphalt/concrete escape areas rather than
  // a grass verge. Las Vegas is deliberately paved all the way to the
  // barriers: its off-track area is part of theStrip race surface, not a
  // field.
  monaco: "paved",
  singapore: "paved",
  baku: "paved",
  lasvegas: "paved",

  // Desert circuits use broad sand/gravel runoffs. Keeping this as a
  // distinct kind (rather than painting everything green) also gives the
  // surface model a believable low-grip, high-drag punishment for a slide.
  bahrain: "gravel",
  lusail: "gravel",
};

const RUNOFF_COLORS: Record<RunoffKind, string> = {
  grass: "#2E4A24",
  paved: "#3B3D42",
  gravel: "#8A7958",
};

export function runoffKindForTrack(trackId: string): RunoffKind {
  return RUNOFF_BY_TRACK[trackId] ?? "grass";
}

export function runoffColorForTrack(trackId: string): string {
  return RUNOFF_COLORS[runoffKindForTrack(trackId)];
}

/** True when the runoff should use an asphalt/concrete texture. */
export function isPavedRunoff(trackId: string): boolean {
  return runoffKindForTrack(trackId) === "paved";
}
