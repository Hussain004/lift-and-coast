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
  /** Real-world reference facts (not derived): corner count from the
   * circuit's own map, and the map pin from the raw dataset's centroid.
   * Still metadata, not geometry - two floats and a count cost nothing in
   * the menu bundle (see the note above). */
  corners: number;
  lat: number;
  lon: number;
}

export const TRACKS: TrackMeta[] = [
  { id: "silverstone", name: "Silverstone Circuit", shortName: "Silverstone", corners: 18, lat: 52.0718, lon: -1.0164 },
  { id: "monza", name: "Autodromo Nazionale Monza", shortName: "Monza", corners: 11, lat: 45.6234, lon: 9.2865 },
  { id: "spa", name: "Circuit de Spa-Francorchamps", shortName: "Spa", corners: 19, lat: 50.4347, lon: 5.9686 },
  { id: "suzuka", name: "Suzuka International Racing Course", shortName: "Suzuka", corners: 18, lat: 34.8446, lon: 136.5328 },
  { id: "monaco", name: "Circuit de Monaco", shortName: "Monaco", corners: 19, lat: 43.7372, lon: 7.4253 },
  { id: "spielberg", name: "Red Bull Ring", shortName: "Spielberg", corners: 10, lat: 47.2228, lon: 14.7624 },
  { id: "bahrain", name: "Bahrain International Circuit", shortName: "Bahrain", corners: 15, lat: 26.0315, lon: 50.5143 },
  { id: "cota", name: "Circuit of the Americas", shortName: "COTA", corners: 20, lat: 30.1347, lon: -97.6340 },
  { id: "zandvoort", name: "Circuit Zandvoort", shortName: "Zandvoort", corners: 14, lat: 52.3881, lon: 4.5459 },
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