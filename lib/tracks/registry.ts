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
  { id: "budapest", name: "Hungaroring", shortName: "Budapest", corners: 14, lat: 47.5830, lon: 19.2495 },
  { id: "melbourne", name: "Albert Park Circuit", shortName: "Melbourne", corners: 14, lat: -37.8460, lon: 144.9704 },
  { id: "montreal", name: "Circuit Gilles-Villeneuve", shortName: "Montreal", corners: 14, lat: 45.5057, lon: -73.5259 },
  { id: "mexico", name: "Autodromo Hermanos Rodriguez", shortName: "Mexico", corners: 17, lat: 19.4017, lon: -99.0900 },
  { id: "shanghai", name: "Shanghai International Circuit", shortName: "Shanghai", corners: 16, lat: 31.3407, lon: 121.2214 },
  { id: "interlagos", name: "Autodromo Jose Carlos Pace", shortName: "Interlagos", corners: 15, lat: -23.7017, lon: -46.6973 },
  { id: "yasmarina", name: "Yas Marina Circuit", shortName: "Yas Marina", corners: 16, lat: 24.4709, lon: 54.6056 },
  { id: "hockenheim", name: "Hockenheimring", shortName: "Hockenheim", corners: 13, lat: 49.3297, lon: 8.5743 },
  { id: "sepang", name: "Sepang International Circuit", shortName: "Sepang", corners: 15, lat: 2.7609, lon: 101.7378 },
  { id: "sochi", name: "Sochi Autodrom", shortName: "Sochi", corners: 18, lat: 43.4075, lon: 39.9587 },
  { id: "nurburgring", name: "Nürburgring Grand Prix Circuit", shortName: "Nürburgring", corners: 15, lat: 50.3308, lon: 6.9421 },
  // 2026-season additions - the seven rounds the roster was still missing
  // (seventeen of the season's twenty-three were already here, plus the four
  // legacy circuits above). Corner counts are the circuits' own published
  // figures and the pins are the raw dataset's bbox centres, same sourcing as
  // every other row (see scripts/build-track.mts for the geometry rows).
  { id: "miami", name: "Miami International Autodrome", shortName: "Miami", corners: 19, lat: 25.9580, lon: -80.2375 },
  { id: "barcelona", name: "Circuit de Barcelona-Catalunya", shortName: "Barcelona", corners: 14, lat: 41.5695, lon: 2.2580 },
  { id: "madrid", name: "Circuito de Madring", shortName: "Madrid", corners: 22, lat: 40.4725, lon: -3.6185 },
  { id: "baku", name: "Baku City Circuit", shortName: "Baku", corners: 20, lat: 40.3695, lon: 49.8430 },
  { id: "singapore", name: "Marina Bay Street Circuit", shortName: "Singapore", corners: 19, lat: 1.2910, lon: 103.8580 },
  { id: "lasvegas", name: "Las Vegas Strip Circuit", shortName: "Las Vegas", corners: 17, lat: 36.1170, lon: -115.1665 },
  { id: "lusail", name: "Lusail International Circuit", shortName: "Lusail", corners: 16, lat: 25.4905, lon: 51.4535 },
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