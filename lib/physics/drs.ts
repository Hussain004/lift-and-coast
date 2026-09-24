/**
 * Pre-2026 compatibility surface. DRS is no longer a game mechanic; all
 * runtime code should import the 2026 overtake model from ./overtake.
 */
export {
  buildOvertakeZones,
  createOvertakeSystem,
  overtakeSummary,
  OVERTAKE_BOOST_MULTIPLIER,
  OVERTAKE_MIN_SPEED_MS,
  OVERTAKE_WINDOW_SECONDS,
} from "./overtake";
export type { OvertakeMode, OvertakeState, OvertakeZone } from "./overtake";

import {
  buildOvertakeZones,
  createOvertakeSystem,
  overtakeSummary,
  OVERTAKE_MIN_SPEED_MS,
} from "./overtake";
import type { OvertakeState, OvertakeZone } from "./overtake";

/** @deprecated Use OVERTAKE_MIN_SPEED_MS. */
export const DRS_MIN_SPEED_MS = OVERTAKE_MIN_SPEED_MS;
/** @deprecated Overtake mode is a power/energy feature, not drag reduction. */
export const DRS_DRAG_SCALE = 1;
/** @deprecated Use OvertakeZone. */
export type DrsZone = OvertakeZone;
/** @deprecated Use OvertakeState. */
export type DrsState = OvertakeState;

/** @deprecated Use createOvertakeSystem. */
export function createDrsSystem(track: Parameters<typeof createOvertakeSystem>[0]) {
  return createOvertakeSystem(track, "race");
}

/** @deprecated Use buildOvertakeZones. */
export function buildDrsZones(track: Parameters<typeof buildOvertakeZones>[0]): OvertakeZone[] {
  return buildOvertakeZones(track);
}

/** @deprecated Use overtakeSummary. */
export function drsSummary(state: OvertakeState): string {
  return overtakeSummary(state);
}
