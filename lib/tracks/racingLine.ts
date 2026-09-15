import type { TrackData } from "./types";

// Plan section 4 point 8 ("racing line... drives the AI and the optional
// ideal-line overlay") and section 13 ("optional ideal-line overlay
// assist"). A full curvature-minimization pass constrained to track bounds,
// then hand-tuned per corner, is future work once there's an AI opponent to
// actually drive it (plan section 6) - this is a cheap local heuristic
// instead: offset each centerline point toward the inside of the curve
// ahead, scaled by how sharp that curve is (measured by how much the
// track's own tangent direction turns over a lookahead window), and capped
// well inside the track's half-width so the line never leaves the drivable
// surface. Good enough for a visual "where should I be pointing" assist;
// not yet accurate enough to drive an AI opponent's line.
const LOOKAHEAD_POINTS = 20;
const MAX_OFFSET_FRACTION_OF_HALF_WIDTH = 0.6;
const OFFSET_GAIN = 40;

function unitTangentAt(track: TrackData, i: number): { x: number; z: number } {
  const n = track.centerline.length;
  const [px, , pz] = track.centerline[(i - 1 + n) % n];
  const [nx, , nz] = track.centerline[(i + 1) % n];
  const tx = nx - px;
  const tz = nz - pz;
  const len = Math.hypot(tx, tz) || 1;
  return { x: tx / len, z: tz / len };
}

/**
 * A racing-line approximation as a closed loop of [x, y, z] points, one per
 * centerline point (same indexing as track.centerline, so callers that
 * already work with centerline indices - e.g. sector gates - line up
 * directly with this).
 */
export function computeRacingLine(track: TrackData): [number, number, number][] {
  const n = track.centerline.length;
  const line: [number, number, number][] = [];

  for (let i = 0; i < n; i++) {
    const behind = unitTangentAt(track, (i - LOOKAHEAD_POINTS + n) % n);
    const ahead = unitTangentAt(track, (i + LOOKAHEAD_POINTS) % n);
    // 2D cross product of the behind->ahead tangents: sign gives which way
    // the track is turning over this window, magnitude scales with how
    // sharp the turn is (0 on a straight, where behind and ahead tangents
    // point the same way).
    const turn = behind.x * ahead.z - behind.z * ahead.x;

    const tangent = unitTangentAt(track, i);
    // Perpendicular to the tangent - same "right" convention as
    // buildRibbonGeometry in mesh.ts.
    const rightX = -tangent.z;
    const rightZ = tangent.x;

    const halfWidth = track.width[i] / 2;
    const maxOffset = halfWidth * MAX_OFFSET_FRACTION_OF_HALF_WIDTH;
    // Verified against a synthetic circular track (see racingLine.test.ts):
    // a positive turn (see above) must offset toward "right" here to land
    // closer to the circle's own center - i.e. hug the inside of the turn,
    // not the outside.
    const offset = Math.max(-maxOffset, Math.min(maxOffset, turn * OFFSET_GAIN));

    const [x, y, z] = track.centerline[i];
    line.push([x + rightX * offset, y, z + rightZ * offset]);
  }

  return line;
}
