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

const TRACK_DATA: Record<string, TrackData> = {
  silverstone: silverstone as TrackData,
  monza: monza as TrackData,
  spa: spa as TrackData,
  suzuka: suzuka as TrackData,
  monaco: monaco as TrackData,
};

export function getTrack(id: string): TrackData {
  return isKnownTrackId(id) ? TRACK_DATA[id] : TRACK_DATA[DEFAULT_TRACK_ID];
}