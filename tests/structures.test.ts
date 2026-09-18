import { describe, expect, it } from "vitest";
import {
  buildStructureGeometry,
  defaultMassingHeightM,
  footprintOf,
  getStructures,
  pitWallRuns,
  getStructuresCenter,
  isStandName,
  pushBox,
  resolveOverlap,
  type BoxSpec,
} from "../lib/tracks/structures";
import { hexToLinearRgb } from "../lib/tracks/mesh";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import type { TrackData } from "../lib/tracks/types";

function rectRing(
  cx: number,
  cz: number,
  len: number,
  wid: number,
  yawDeg: number
): [number, number][] {
  const yaw = (yawDeg * Math.PI) / 180;
  const ux = Math.cos(yaw);
  const uz = Math.sin(yaw);
  const vx = -uz;
  const vz = ux;
  const corners: [number, number][] = [];
  for (const [du, dv] of [
    [-len / 2, -wid / 2],
    [len / 2, -wid / 2],
    [len / 2, wid / 2],
    [-len / 2, wid / 2],
  ] as [number, number][]) {
    corners.push([cx + du * ux + dv * vx, cz + du * uz + dv * vz]);
  }
  corners.push(corners[0]);
  return corners;
}

describe("footprintOf", () => {
  it("recovers center and extents of an axis-aligned bar", () => {
    const fp = footprintOf(rectRing(10, -4, 100, 20, 0));
    expect(fp.cx).toBeCloseTo(10, 6);
    expect(fp.cz).toBeCloseTo(-4, 6);
    expect(fp.lengthM).toBeCloseTo(100, 6);
    expect(fp.widthM).toBeCloseTo(20, 6);
  });

  it("recovers extents of a rotated bar, long axis along the bar", () => {
    const fp = footprintOf(rectRing(0, 0, 100, 20, 30));
    expect(fp.lengthM).toBeCloseTo(100, 6);
    expect(fp.widthM).toBeCloseTo(20, 6);
    // PCA long axis is directionless: 30deg or 30+180, never across the bar.
    const deg = ((fp.yaw * 180) / Math.PI) % 180;
    const norm = deg < 0 ? deg + 180 : deg;
    expect(Math.min(Math.abs(norm - 30), Math.abs(norm - 30 - 180))).toBeLessThan(0.01);
  });
});

describe("pushBox", () => {
  it("winds every face outward, even rotated", () => {
    const spec: BoxSpec = {
      cx: 5,
      yBase: 2,
      cz: -3,
      sx: 10,
      sy: 4,
      sz: 6,
      yaw: 0.7,
      color: [1, 0, 0],
    };
    const positions: number[] = [];
    const indices: number[] = [];
    const colors: number[] = [];
    pushBox(positions, indices, colors, spec);
    expect(indices.length).toBe(36);
    const center = [spec.cx, spec.yBase + spec.sy / 2, spec.cz];
    for (let t = 0; t < indices.length; t += 3) {
      const tri = [indices[t], indices[t + 1], indices[t + 2]].map((v) => [
        positions[v * 3],
        positions[v * 3 + 1],
        positions[v * 3 + 2],
      ]);
      const e1 = [tri[1][0] - tri[0][0], tri[1][1] - tri[0][1], tri[1][2] - tri[0][2]];
      const e2 = [tri[2][0] - tri[0][0], tri[2][1] - tri[0][1], tri[2][2] - tri[0][2]];
      const normal = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const mid = [
        (tri[0][0] + tri[1][0] + tri[2][0]) / 3 - center[0],
        (tri[0][1] + tri[1][1] + tri[2][1]) / 3 - center[1],
        (tri[0][2] + tri[1][2] + tri[2][2]) / 3 - center[2],
      ];
      expect(
        normal[0] * mid[0] + normal[1] * mid[1] + normal[2] * mid[2],
        `face ${t / 3} points inward`
      ).toBeGreaterThan(0);
    }
  });
});

describe("resolveOverlap", () => {
  // Straight 40m test road along x, 10m wide.
  const road: TrackData = {
    id: "straight",
    name: "straight",
    lengthMeters: 40,
    centerline: Array.from({ length: 21 }, (_, i) => [i * 2, 0, 0] as [number, number, number]),
    width: Array.from({ length: 21 }, () => 10),
    startPos: { x: 0, z: 0, headingRad: 0 },
  };

  it("drops a bar lying along the ribbon rather than relocating it", () => {
    // 30x8 bar centered on the line: clearing needs ~7m, more than half
    // its 8m width - shifting would invent a new address, so null.
    const placed = resolveOverlap(road, {
      cx: 20,
      cz: 0,
      yaw: 0,
      lengthM: 30,
      widthM: 8,
    });
    expect(placed).toBeNull();
  });

  it("nudges a bar clipping the asphalt edge and leaves a clear one alone", () => {
    // Box spans z 4..12: clips 1m of the 5m half width.
    const clipping = resolveOverlap(road, {
      cx: 20,
      cz: 8,
      yaw: 0,
      lengthM: 30,
      widthM: 8,
    });
    expect(clipping).not.toBeNull();
    expect(Math.abs(clipping!.cz)).toBeGreaterThan(8);
    // Well clear of the road: untouched.
    const clear = resolveOverlap(road, {
      cx: 20,
      cz: 30,
      yaw: 0,
      lengthM: 30,
      widthM: 8,
    });
    expect(clear).toEqual({ cx: 20, cz: 30 });
  });
});

describe("isStandName", () => {
  it("routes stand-named buildings to stand massing", () => {
    expect(isStandName("Stand F1")).toBe(true);
    expect(isStandName("Stand Endurance")).toBe(true);
    expect(isStandName("Tribuna Centrale")).toBe(true);
    expect(isStandName("Pit Stop Cafe")).toBe(false);
    expect(isStandName("Le Portobello")).toBe(false);
    expect(isStandName("Voie des stands")).toBe(false);
    expect(isStandName(null)).toBe(false);
  });
});

describe("defaultMassingHeightM", () => {
  it("keeps sheds low and houses tall", () => {
    // Regression for the Spa start-line "tower": a 3m utility cabinet
    // mapped as a building rendered as an 8m totem pole.
    expect(defaultMassingHeightM({ cx: 0, cz: 0, yaw: 0, lengthM: 3, widthM: 3 })).toBeCloseTo(2.5, 6);
    expect(defaultMassingHeightM({ cx: 0, cz: 0, yaw: 0, lengthM: 10, widthM: 8 })).toBeCloseTo(6.4, 6);
    expect(defaultMassingHeightM({ cx: 0, cz: 0, yaw: 0, lengthM: 40, widthM: 30 })).toBe(8);
  });
});

describe("vendored structures", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} has mapped structures with sane rings`, () => {
      const structs = getStructures(entry.id);
      expect(structs.length).toBeGreaterThan(0);
      for (const s of structs) {
        expect(s.ring.length).toBeGreaterThanOrEqual(2);
        expect(["grandstand", "building", "barrier", "attraction", "tunnel", "pitlane"]).toContain(
          s.kind
        );
        if (s.kind === "building" || s.kind === "grandstand" || s.kind === "attraction") {
          const first = s.ring[0];
          const last = s.ring[s.ring.length - 1];
          expect(
            Math.hypot(first[0] - last[0], first[1] - last[1]),
            `${entry.id} ${s.kind} "${s.name}" is not closed`
          ).toBeLessThan(1e-9);
        }
      }
      // Every circuit has its pit lane mapped (pit walls derive from it).
      expect(structs.some((s) => s.kind === "pitlane"), `${entry.id} has no pit lane`).toBe(true);
    });
  }
});

describe("buildStructureGeometry (real circuits)", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} builds non-empty, well-formed geometry`, () => {
      const track = getTrack(entry.id);
      const { solid, visual } = buildStructureGeometry(track);
      expect(solid.positions.length).toBeGreaterThan(3000);
      expect(solid.indices.length % 3).toBe(0);
      expect(solid.colors.length).toBe(solid.positions.length);
      const verts = solid.positions.length / 3;
      let maxIndex = -1;
      for (let i = 0; i < solid.indices.length; i++) {
        maxIndex = Math.max(maxIndex, solid.indices[i]);
      }
      expect(maxIndex).toBeLessThan(verts);
      for (let i = 0; i < solid.positions.length; i++) {
        expect(Number.isFinite(solid.positions[i])).toBe(true);
      }
      for (let i = 0; i < solid.positions.length; i++) {
        expect(Number.isFinite(solid.positions[i])).toBe(true);
        expect(Number.isFinite(solid.colors[i])).toBe(true);
      }
      for (let i = 0; i < solid.colors.length; i++) {
        expect(solid.colors[i]).toBeGreaterThanOrEqual(0);
        expect(solid.colors[i]).toBeLessThanOrEqual(1);
      }
      void visual;
    });

    it(`${entry.id} keeps solid massing off the asphalt`, () => {
      // The terrain clearance equivalent for buildings: nothing solid may
      // sit ON the road where the car drives. Walls beside the track (pit
      // walls, guardrails) are expected, and so is massing with real
      // vertical separation (a fence on the bank above the track, a roof
      // slab on the hill above the road) - the failure is massing inside
      // the asphalt at track level.
      const track = getTrack(entry.id);
      const { solid } = buildStructureGeometry(track);
      const n = track.centerline.length;
      const verts = solid.positions.length / 3;
      for (let v = 0; v < verts; v++) {
        const x = solid.positions[v * 3];
        const y = solid.positions[v * 3 + 1];
        const z = solid.positions[v * 3 + 2];
        let best = Infinity;
        let bestI = 0;
        for (let i = 0; i < n; i += 2) {
          const dx = track.centerline[i][0] - x;
          const dz = track.centerline[i][2] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) {
            best = d2;
            bestI = i;
          }
        }
        const [cx, cy, cz] = track.centerline[bestI];
        const [px, , pz] = track.centerline[(bestI - 1 + n) % n];
        const [nx, , nz] = track.centerline[(bestI + 1) % n];
        const tx = nx - px;
        const tz = nz - pz;
        const len = Math.hypot(tx, tz) || 1;
        const lateral = Math.abs(((x - cx) * -tz + (z - cz) * tx) / len);
        const halfW = track.width[bestI] / 2;
        expect(
          lateral < halfW - 0.5 && y > cy - 0.5 && y < cy + 2,
          `${entry.id}: solid vertex ${v} on the road at track level`
        ).toBe(false);
      }
    });

    it(`${entry.id} derives pit walls`, () => {
      const track = getTrack(entry.id);
      const { centerLon, centerLat } = getStructuresCenter(entry.id);
      const structs = getStructures(entry.id);
      const lanes = structs
        .filter((s) => s.kind === "pitlane")
        .map((s) => ({ ring: s.ring, centerLon, centerLat }));
      const buildings = structs
        .filter((s) => s.kind === "building")
        .map((s) => ({ ring: s.ring, centerLon, centerLat, name: s.name }));
      const runs = pitWallRuns(track, lanes, buildings);
      expect(runs.length).toBeGreaterThan(0);
      for (const run of runs) {
        expect(run.side === 1 || run.side === -1).toBe(true);
        expect(run.toStation - run.fromStation).toBeGreaterThanOrEqual(100);
      }
    });
  }

  it("monaco builds tunnel roofs over the ribbon", () => {
    const track = getTrack("monaco");
    const { visual } = buildStructureGeometry(track);
    expect(visual.positions.length / 3).toBeGreaterThan(0);
    // Slabs sit above the car, centered near the track they cover.
    const n = track.centerline.length;
    const verts = visual.positions.length / 3;
    for (let v = 0; v < verts; v++) {
      const x = visual.positions[v * 3];
      const y = visual.positions[v * 3 + 1];
      const z = visual.positions[v * 3 + 2];
      let best = Infinity;
      let bestI = 0;
      for (let i = 0; i < n; i += 2) {
        const dx = track.centerline[i][0] - x;
        const dz = track.centerline[i][2] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) {
          best = d2;
          bestI = i;
        }
      }
      const [, cy] = track.centerline[bestI];
      expect(y, "tunnel roof below car height").toBeGreaterThan(cy + 3);
      expect(Math.sqrt(best), "tunnel roof far from the ribbon").toBeLessThan(
        track.width[bestI] / 2 + 10
      );
    }
  });

  it("suzuka builds no phantom tunnel roofs", () => {
    // Regression: a tunnel way jumping 1.3km across the lap (portal to
    // portal) interpolated a roof over the whole jump - 86 slabs. Runs
    // split on 400m+ node jumps now, so only genuinely contiguous,
    // track-touching runs get slabs.
    const { visual } = buildStructureGeometry(getTrack("suzuka"));
    expect(visual.positions.length / 3).toBeLessThan(200);
  });

  it("suzuka builds the circuit wheel landmark", () => {
    const { solid } = buildStructureGeometry(getTrack("suzuka"));
    const cabin = hexToLinearRgb("#C0392B");
    let found = false;
    const verts = solid.positions.length / 3;
    for (let v = 0; v < verts; v++) {
      if (
        Math.abs(solid.colors[v * 3] - cabin[0]) < 1e-6 &&
        Math.abs(solid.colors[v * 3 + 1] - cabin[1]) < 1e-6 &&
        Math.abs(solid.colors[v * 3 + 2] - cabin[2]) < 1e-6
      ) {
        found = true;
        break;
      }
    }
    expect(found, "no ferris-wheel cabins in suzuka massing").toBe(true);
  });

  it.each(["silverstone", "monza", "spa"])(
    "%s renders grandstand seating in the massing",
    (id) => {
      // The red back wall only comes from emitGrandstand - pins the stand
      // massing (including Spa's tag-less "Stand F1", routed by name).
      const { solid } = buildStructureGeometry(getTrack(id));
      const seats = hexToLinearRgb("#8A2F24");
      let found = false;
      const verts = solid.positions.length / 3;
      for (let v = 0; v < verts; v++) {
        if (
          Math.abs(solid.colors[v * 3] - seats[0]) < 1e-6 &&
          Math.abs(solid.colors[v * 3 + 1] - seats[1]) < 1e-6 &&
          Math.abs(solid.colors[v * 3 + 2] - seats[2]) < 1e-6
        ) {
          found = true;
          break;
        }
      }
      expect(found, `no grandstand seating in ${id} massing`).toBe(true);
    }
  );
});
