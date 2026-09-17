// Plan section 4 / Phase 4 (content scale-out): the circuit LIST - ids and
// display names only, with no track geometry imported. The home-screen
// session setup and the race page's URL parsing both need to resolve an id
// without pulling ~550KB of centerline data into the menu route's bundle
// (plan section 14: menus stay light; per-track assets load with the
// race route). The actual geometry lives in trackData.ts, imported only by
// the race route.
export interface TrackMeta {
  id: string;
  name: string;
  /** Short label for the session-setup track picker buttons. */
  shortName: string;
}

export const TRACKS: TrackMeta[] = [
  { id: "silverstone", name: "Silverstone Circuit", shortName: "Silverstone" },
  { id: "monza", name: "Autodromo Nazionale Monza", shortName: "Monza" },
  { id: "spa", name: "Circuit de Spa-Francorchamps", shortName: "Spa" },
  { id: "suzuka", name: "Suzuka International Racing Course", shortName: "Suzuka" },
  { id: "monaco", name: "Circuit de Monaco", shortName: "Monaco" },
];

export const DEFAULT_TRACK_ID = TRACKS[0].id;

export function isKnownTrackId(id: string): boolean {
  return TRACKS.some((t) => t.id === id);
}

/**
 * Resolves a `?track=` URL value to a known track id - unknown/missing
 * values fall back to the default instead of throwing, so a stale or
 * hand-edited link can't white-screen the race.
 */
export function parseTrackId(raw: string | null): string {
  return raw !== null && isKnownTrackId(raw) ? raw : DEFAULT_TRACK_ID;
}

export function getTrackName(id: string): string {
  const entry = TRACKS.find((t) => t.id === id);
  return entry ? entry.name : TRACKS[0].name;
}