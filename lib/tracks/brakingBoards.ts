// Trackside distance boards: "100" and "50" metres before the big braking
// zones, as on every real circuit. Derived from the racing line's own brake
// zones, so a board sits exactly where the ribbon turns red - useful, not
// decoration. Pure (no three.js); app/race/Track.tsx draws the result.
import type { RacingLinePoint, ThrottleZone } from "./racingLine";
import type { TrackData } from "./types";

export interface BrakingBoard {
  x: number;
  y: number;
  z: number;
  /** Rotation about Y that turns the board's face toward oncoming cars. */
  yawRad: number;
  /** Metres to the braking point: 300, 200, 100 or 50. */
  meters: number;
}

export const BOARD_DISTANCES_METERS = [300, 200, 100, 50] as const;
/** A zone only earns boards if the car sheds this much speed (m/s, ~90 km/h). */
const MIN_SPEED_DROP_MS = 25;
/** Metres from the track edge to the board's post. */
const EDGE_SETBACK_METERS = 3.5;

const isBrake = (zone: ThrottleZone) => zone === "brake-medium" || zone === "brake-hard";
const zoneOf = (p: RacingLinePoint): ThrottleZone => p.displayZone ?? p.zone;
const speedOf = (p: RacingLinePoint) => p.displayTargetSpeedMs ?? p.targetSpeedMs;

/** Nearest centreline index (the line has the same handful of thousand points). */
function nearestCenterIndex(track: TrackData, x: number, z: number, hint: number): number {
  const n = track.centerline.length;
  let best = hint;
  let bestD = Infinity;
  // The line and the centreline are both closed loops around the same lap,
  // so a windowed search around the proportional index is enough.
  for (let k = -80; k <= 80; k++) {
    const i = (hint + k + n) % n;
    const [cx, , cz] = track.centerline[i];
    const d = (cx - x) ** 2 + (cz - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function computeBrakingBoards(track: TrackData, line: RacingLinePoint[]): BrakingBoard[] {
  const n = line.length;
  if (n < 10 || track.centerline.length < 10) return [];
  const boards: BrakingBoard[] = [];
  for (let start = 0; start < n; start++) {
    const prev = (start - 1 + n) % n;
    if (!isBrake(zoneOf(line[start])) || isBrake(zoneOf(line[prev]))) continue;

    // The run and how much speed it sheds.
    let end = start;
    let minSpeed = speedOf(line[start]);
    while (isBrake(zoneOf(line[(end + 1) % n])) && end - start < n) {
      end++;
      minSpeed = Math.min(minSpeed, speedOf(line[end % n]));
    }
    const entrySpeed = speedOf(line[start]);
    if (entrySpeed - minSpeed < MIN_SPEED_DROP_MS) continue;

    // Which side is the corner? Cross of the heading at the entry and at the
    // slowest point of the run; boards go on the outside of it.
    const at = (i: number) => line[((i % n) + n) % n].position;
    const heading = (i: number) => {
      const a = at(i);
      const b = at(i + 3);
      return Math.atan2(b[0] - a[0], b[2] - a[2]);
    };
    let turn = heading(end) - heading(start - 3);
    turn = Math.atan2(Math.sin(turn), Math.cos(turn));
    const outsideSign = turn > 0 ? -1 : 1;

    for (const meters of BOARD_DISTANCES_METERS) {
      // Walk back along the lap by arc length.
      let i = start;
      let walked = 0;
      while (walked < meters) {
        i = (i - 1 + n) % n;
        walked += line[i].distanceToNextMeters;
        if (walked > 2000) break;
      }
      const p = line[i];
      // Skip a board that would land inside another braking zone or slow
      // corner (a chicane, or the run-in of a hairpin complex).
      if (isBrake(zoneOf(p)) || speedOf(p) < entrySpeed * 0.9) continue;
      const q = line[(i + 3) % n];
      const dx = q.position[0] - p.position[0];
      const dz = q.position[2] - p.position[2];
      const len = Math.hypot(dx, dz) || 1;
      const fx = dx / len;
      const fz = dz / len;
      const ci = nearestCenterIndex(track, p.position[0], p.position[2], Math.round((i / n) * track.centerline.length));
      const half = (track.width[ci] ?? 12) / 2;
      // The driver's right is (-fz, fx); outsideSign is -1 when the corner
      // turns left (outside = right), +1 when it turns right.
      const nx = fz * outsideSign;
      const nz = -fx * outsideSign;
      const off = half + EDGE_SETBACK_METERS;
      const cl = track.centerline[ci];
      boards.push({
        x: cl[0] + nx * off,
        y: p.position[1],
        z: cl[2] + nz * off,
        // The board's face normal is +Z rotated by yaw; cars come from behind
        // it along the direction of travel, so face back along -forward.
        yawRad: Math.atan2(-fx, -fz),
        meters,
      });
    }
    start = end; // resume after this zone
  }
  return boards;
}

/** Atlas cell per board: the four distance faces, then a plain post colour. */
export const BOARD_CELLS = 5;
const POST_CELL = 4;
const PANEL_WIDTH = 2.1;
const PANEL_HEIGHT = 1.5;
const PANEL_BASE = 1.5;
const POST_HALF = 0.05;

export interface BoardMesh {
  positions: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * One merged mesh for every board: a post and a face turned toward oncoming
 * cars, the face's UVs picking its distance out of a BOARD_CELLS-wide atlas
 * (cells in BOARD_DISTANCES_METERS order). Double-sided, so winding is moot.
 */
export function buildBoardMesh(boards: readonly BrakingBoard[]): BoardMesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const quad = (c: [number, number, number][], cell: number) => {
    const base = positions.length / 3;
    const u0 = cell / BOARD_CELLS + 0.004;
    const u1 = (cell + 1) / BOARD_CELLS - 0.004;
    const uv = [u0, 0.02, u1, 0.02, u1, 0.98, u0, 0.98];
    for (let k = 0; k < 4; k++) {
      positions.push(...c[k]);
      uvs.push(uv[k * 2], uv[k * 2 + 1]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (const b of boards) {
    const cell = Math.max(0, BOARD_DISTANCES_METERS.indexOf(b.meters as (typeof BOARD_DISTANCES_METERS)[number]));
    // Local X (across the face) and the face normal, from the yaw.
    const rx = Math.cos(b.yawRad);
    const rz = -Math.sin(b.yawRad);
    const at = (across: number, y: number): [number, number, number] => [b.x + rx * across, b.y + y, b.z + rz * across];
    quad(
      [
        at(-PANEL_WIDTH / 2, PANEL_BASE),
        at(PANEL_WIDTH / 2, PANEL_BASE),
        at(PANEL_WIDTH / 2, PANEL_BASE + PANEL_HEIGHT),
        at(-PANEL_WIDTH / 2, PANEL_BASE + PANEL_HEIGHT),
      ],
      cell
    );
    // The post: two crossed strips, sunk a little so a graded verge hides its foot.
    quad([at(-POST_HALF, -0.6), at(POST_HALF, -0.6), at(POST_HALF, PANEL_BASE), at(-POST_HALF, PANEL_BASE)], POST_CELL);
    const nx = Math.sin(b.yawRad);
    const nz = Math.cos(b.yawRad);
    const side = (along: number, y: number): [number, number, number] => [b.x + nx * along, b.y + y, b.z + nz * along];
    quad([side(-POST_HALF, -0.6), side(POST_HALF, -0.6), side(POST_HALF, PANEL_BASE), side(-POST_HALF, PANEL_BASE)], POST_CELL);
  }
  return {
    positions: new Float32Array(positions),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}
