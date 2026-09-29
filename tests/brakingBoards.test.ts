import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { getRacingLine } from "../lib/tracks/racingLineCache";
import { BOARD_CELLS, BOARD_DISTANCES_METERS, buildBoardMesh, computeBrakingBoards } from "../lib/tracks/brakingBoards";

describe("braking boards", () => {
  it("every circuit gets boards, off the tarmac, at real distances", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const boards = computeBrakingBoards(track, getRacingLine(track));
      expect(boards.length, meta.id).toBeGreaterThanOrEqual(6);
      for (const b of boards) {
        expect(BOARD_DISTANCES_METERS as readonly number[]).toContain(b.meters);
        let nearest = Infinity;
        let half = 0;
        track.centerline.forEach(([x, , z], i) => {
          const d = Math.hypot(x - b.x, z - b.z);
          if (d < nearest) {
            nearest = d;
            half = track.width[i] / 2;
          }
        });
        // Outside the painted edge (and not in a barrier a hundred metres out).
        expect(nearest, `${meta.id} ${b.meters}`).toBeGreaterThan(half + 1);
        expect(nearest, `${meta.id} ${b.meters}`).toBeLessThan(half + 12);
      }
    }
  });

  it("builds a well-formed merged mesh", () => {
    const track = getTrack("monza");
    const boards = computeBrakingBoards(track, getRacingLine(track));
    const mesh = buildBoardMesh(boards);
    expect(mesh.indices.length).toBe(boards.length * 3 * 6);
    expect(mesh.uvs.length / 2).toBe(mesh.positions.length / 3);
    expect(Math.max(...mesh.uvs)).toBeLessThanOrEqual(1);
    expect(Math.min(...mesh.uvs)).toBeGreaterThanOrEqual(0);
    expect(BOARD_CELLS).toBe(BOARD_DISTANCES_METERS.length + 1);
  });
});
