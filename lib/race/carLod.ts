// Level of detail for rival cars: beyond SWITCH_OUT_M the seven-mesh car is
// swapped for a single merged low-poly mesh (see buildFarCarGeometry). The
// two thresholds differ so a car hovering at the boundary doesn't flicker.
export const LOD_SWITCH_OUT_M = 80;
export const LOD_SWITCH_IN_M = 65;

/** Whether a car `distSq` (squared meters) from the camera should draw its far version. */
export function wantsFarLod(currentlyFar: boolean, distSq: number): boolean {
  const limit = currentlyFar ? LOD_SWITCH_IN_M : LOD_SWITCH_OUT_M;
  return distSq > limit * limit;
}
