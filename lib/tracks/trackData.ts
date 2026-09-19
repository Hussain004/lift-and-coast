// Track geometry loader - the only module that imports the built circuit
// JSON, and therefore the only one that must be kept out of menu routes
// (see registry.ts). The race route resolves the selected id here after
// parsing it against the metadata registry.
import type { TrackData } from "./types";
import { DEFAULT_TRACK_ID, isKnownTrackId } from "./registry";
import silverstone from "../../data/tracks/silverstone.json";
import monza from "../../data/tracks/monza.json";
import spa from "../../data/tracks/spa.json";
import suzuka from "../../data/tracks/suzuka.json";
import monaco from "../../data/tracks/monaco.json";
import spielberg from "../../data/tracks/spielberg.json";
import bahrain from "../../data/tracks/bahrain.json";
import cota from "../../data/tracks/cota.json";
import zandvoort from "../../data/tracks/zandvoort.json";
import budapest from "../../data/tracks/budapest.json";
import melbourne from "../../data/tracks/melbourne.json";
import montreal from "../../data/tracks/montreal.json";
import mexico from "../../data/tracks/mexico.json";
import shanghai from "../../data/tracks/shanghai.json";
import interlagos from "../../data/tracks/interlagos.json";
import yasmarina from "../../data/tracks/yasmarina.json";

const TRACK_DATA: Record<string, TrackData> = {
  silverstone: silverstone as TrackData,
  monza: monza as TrackData,
  spa: spa as TrackData,
  suzuka: suzuka as TrackData,
  monaco: monaco as TrackData,
  spielberg: spielberg as TrackData,
  bahrain: bahrain as TrackData,
  cota: cota as TrackData,
  zandvoort: zandvoort as TrackData,
  budapest: budapest as TrackData,
  melbourne: melbourne as TrackData,
  montreal: montreal as TrackData,
  mexico: mexico as TrackData,
  shanghai: shanghai as TrackData,
  interlagos: interlagos as TrackData,
  yasmarina: yasmarina as TrackData,
};

export function getTrack(id: string): TrackData {
  return isKnownTrackId(id) ? TRACK_DATA[id] : TRACK_DATA[DEFAULT_TRACK_ID];
}