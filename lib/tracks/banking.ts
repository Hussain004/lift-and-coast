// Plan section 4 (circuit detail): banked corners. The ribbon mesh is
// built flat across its width (see buildRibbonGeometry in mesh.ts) except
// where this module carries real cross-slope data - currently exactly one
// circuit on the roster: Zandvoort's 2020 resurfacing banked the
// Hugenholtzbocht (T3) to ~19 degrees and the final Arie Luyendijkbocht to
// ~18 degrees, both flat-out corners where the banking is the whole point
// of the corner. No other roster circuit has meaningful banking, so every
// other track reads 0 everywhere and its built bytes never move.
//
// Authored as [stationMeters, degrees] keyframes in lap stations from the
// start line (the same convention as build-track.mts's manual tables),
// cosine-interpolated cyclically so transitions in and out of the banking
// are smooth. Sign: positive raises the RIGHT edge (negative the left) -
// a banked corner always lifts its outside edge, so the sign is checkable
// against the turn direction computed from the centerline itself (see
// tests/banking.test.ts), not a second piece of hand-authored data.
//
// Stations were located from the built centerline's own curvature (corner
// spans T3 ~730-816m, final ~3722-3978m of the 4268m lap); magnitudes are
// the widely published 19/18-degree figures. Only T3 is banked: the final
// corner is a fast banked sweeper that defeats this generation of the
// pursuit controller (measured: 2m downhill slide onto the inside grass at
// 40 m/s, rejoining sideways into a snap spin - and both attempted fixes,
// a raised speed cap and a steering feedforward, moved the failure to
// another corner instead of removing it, the controller's documented
// whack-a-mole). Banking it is one keyframe row, reserved for the
// racecraft/controller work that can actually drive it.
const BANKING_KEYFRAMES_DEG: Record<string, [number, number][]> = {
  zandvoort: [
    [660, 0],
    [730, -19],
    [845, -19],
    [915, 0],
  ],
};

const DEG_TO_RAD = Math.PI / 180;

/**
 * Cross-slope angle in radians at a lap station: positive lifts the right
 * edge, negative the left. Unknown tracks (everything but Zandvoort) read
 * exactly 0, so their geometry builds bit-identically with or without this
 * module in the loop.
 */
export function bankingAt(
  trackId: string,
  stationMeters: number,
  lengthMeters: number
): number {
  const keys = BANKING_KEYFRAMES_DEG[trackId];
  if (!keys || lengthMeters <= 0) return 0;
  const dd = ((stationMeters % lengthMeters) + lengthMeters) % lengthMeters;
  // Containing segment, walking down from the end. Stations before the
  // first keyframe belong to the closing segment (last key -> first key
  // across the line), not to keys[0] - the start line sits mid-straight,
  // so dd < keys[0][0] is the common case, not an edge.
  let i = keys.length - 1;
  if (dd >= keys[0][0]) {
    while (keys[i][0] > dd) i--;
  }
  const a = keys[i];
  const b = keys[(i + 1) % keys.length];
  const bStation = b[0] <= a[0] ? b[0] + lengthMeters : b[0];
  const u =
    bStation === a[0] ? 0 : (dd < a[0] ? dd + lengthMeters - a[0] : dd - a[0]) / (bStation - a[0]);
  const s = (1 - Math.cos(u * Math.PI)) / 2;
  return (a[1] + (b[1] - a[1]) * s) * DEG_TO_RAD;
}

/** Lap station of centerline index i (arc-length from the start line). */
export function stationOf(index: number, count: number, lengthMeters: number): number {
  return (index / count) * lengthMeters;
}

/**
 * Asphalt surface height at a lateral offset from the centerline
 * (positive = right of travel, same convention as the mesh builders):
 * the centerline's own y plus the cross-slope rise. With no banking this
 * is exactly centerY, so unbanked circuits cannot tell the difference.
 */
export function bankedHeight(
  trackId: string,
  stationMeters: number,
  lengthMeters: number,
  centerY: number,
  lateralMeters: number
): number {
  return centerY + Math.sin(bankingAt(trackId, stationMeters, lengthMeters)) * lateralMeters;
}
