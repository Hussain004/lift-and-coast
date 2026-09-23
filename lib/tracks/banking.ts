// Plan section 4 (circuit detail): banked corners. Banking is authored as
// [stationMeters, degrees] keyframes in lap stations from the start line,
// cosine-interpolated cyclically so transitions in and out of the banking
// are smooth. Sign: positive raises the RIGHT edge (negative the left) - a
// banked corner always lifts its outside edge, so the sign is checkable
// against the turn direction computed from the centerline itself (see
// tests/banking.test.ts), not a second piece of hand-authored data.
//
// Zandvoort keeps its published 19-degree Hugenholtzbocht. Madring has
// several fast, elevation-changing turns where a modest crown makes the
// asphalt read as a real circuit rather than a flat ribbon; those sections
// are deliberately gentler than Zandvoort's flat-out banking and are kept
// in the same data path so mesh, kerbs, terrain, and the AI line all move
// together.
const BANKING_KEYFRAMES_DEG: Record<string, [number, number][]> = {
  zandvoort: [
    [660, 0],
    [730, -19],
    [845, -19],
    [915, 0],
  ],
  madrid: [
    [0, 0],
    [120, 0],
    [220, 3.5],
    [340, 3.5],
    [480, 0],
    [1180, 0],
    [1300, 3.5],
    [1450, 0],
    [2300, 0],
    [2470, -3.5],
    [2800, 0],
    [4550, 0],
    [4720, -3.5],
    [5120, -3.5],
    [5280, 0],
  ],
};

const DEG_TO_RAD = Math.PI / 180;

/**
 * Cross-slope angle in radians at a lap station: positive lifts the right
 * edge, negative the left. Unknown tracks (everything without an authored
 * keyframe set) read exactly 0, so their geometry builds bit-identically with
 * or without this module in the loop.
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
