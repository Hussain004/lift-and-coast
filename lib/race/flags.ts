// Marshalling flags derived from where the cars are: a yellow for a stopped
// car on your stretch of track, and a blue when a car a lap ahead is on your
// tail. Pure - the caller feeds it the shared race progress each frame and
// shows the result (banner, chip). It changes nothing about how any car
// drives; it only tells the player what a marshal would.
import type { RaceProgress } from "./racePosition";

export interface FlagRival {
  code: string;
}

export interface FlagStatus {
  /** A stopped car ahead on your stretch: which car and how far, metres. */
  yellow: { code: string; aheadMeters: number } | null;
  /** A lapping car about to pass: which car and how far behind, metres. */
  blue: { code: string; behindMeters: number } | null;
}

export interface FlagState {
  /** Seconds each opponent has been (near) stationary. */
  stoppedSeconds: number[];
}

/** Below this speed a car counts as stopped, m/s. */
export const STOPPED_SPEED_MS = 4;
/** Stopped this long before it is an incident worth a flag, seconds. */
export const INCIDENT_SECONDS = 3;
/** No incidents in the first seconds of the race (grid, formation). */
const OPENING_SECONDS = 20;
const YELLOW_BEFORE_METERS = 300;
const YELLOW_AFTER_METERS = 30;
const BLUE_RANGE_METERS = 150;

export function createFlagState(opponents: number): FlagState {
  return { stoppedSeconds: Array.from({ length: opponents }, () => 0) };
}

/** Signed distance from a to b along the lap, wrapped into (-L/2, L/2]. */
function wrappedGap(fromMeters: number, toMeters: number, lengthMeters: number): number {
  let d = (toMeters - fromMeters) % lengthMeters;
  if (d > lengthMeters / 2) d -= lengthMeters;
  if (d <= -lengthMeters / 2) d += lengthMeters;
  return d;
}

export function stepFlags(
  state: FlagState,
  rivals: readonly FlagRival[],
  player: RaceProgress,
  opponents: readonly RaceProgress[],
  trackLengthMeters: number,
  dt: number,
  raceSeconds: number
): FlagStatus {
  const status: FlagStatus = { yellow: null, blue: null };
  const playerTotal = player.lapCount * trackLengthMeters + player.progressMeters;
  for (let k = 0; k < rivals.length; k++) {
    const opp = opponents[k];
    if (!opp) continue;
    state.stoppedSeconds[k] = raceSeconds > OPENING_SECONDS && !opp.inPit && Math.abs(opp.speedMs ?? 0) < STOPPED_SPEED_MS ? (state.stoppedSeconds[k] ?? 0) + dt : 0;
    const ahead = wrappedGap(player.progressMeters, opp.progressMeters, trackLengthMeters);
    if (state.stoppedSeconds[k] >= INCIDENT_SECONDS && ahead >= -YELLOW_AFTER_METERS && ahead <= YELLOW_BEFORE_METERS) {
      if (!status.yellow || ahead < status.yellow.aheadMeters) status.yellow = { code: rivals[k].code, aheadMeters: ahead };
    }
    // Blue: on the same stretch, behind us, and a lap (or more) further round.
    const oppTotal = opp.lapCount * trackLengthMeters + opp.progressMeters;
    const behind = -ahead;
    if (
      oppTotal - playerTotal > trackLengthMeters - BLUE_RANGE_METERS &&
      behind > 0 &&
      behind < BLUE_RANGE_METERS &&
      (opp.speedMs ?? 0) > (player.speedMs ?? 0) - 3
    ) {
      if (!status.blue || behind < status.blue.behindMeters) status.blue = { code: rivals[k].code, behindMeters: behind };
    }
  }
  return status;
}

export function flagChipText(status: FlagStatus): string {
  if (status.yellow) return `YELLOW · ${status.yellow.code} STOPPED AHEAD`;
  if (status.blue) return `BLUE FLAG · LET ${status.blue.code} PASS`;
  return "";
}
