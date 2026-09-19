import { describe, expect, it } from "vitest";
import {
  buildFlora,
  buildSpeciesGeometry,
  getFloraConfig,
  mulberry32,
} from "../lib/tracks/flora";
import { buildTerrainGeometry, sampleTerrainHeight } from "../lib/tracks/terrain";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";

describe("mulberry32", () => {
  it("is deterministic per seed and varies across seeds", () => {
    const a = mulberry32(1962);
    const b = mulberry32(1962);
    const c = mulberry32(1922);
    const seqA = [a(), a(), a()];
    const seqB = [b(), b(), b()];
    expect(seqB).toEqual(seqA);
    expect(c()).not.toBe(seqA[0]);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("buildSpeciesGeometry", () => {
  it("builds well-formed, finite geometry for both shapes", () => {
    const config = getFloraConfig("suzuka");
    expect(config).not.toBeNull();
    for (const species of config!.species) {
      const geometry = buildSpeciesGeometry(species, 3, 7);
      const pos = geometry.getAttribute("position");
      const color = geometry.getAttribute("color");
      expect(pos.count).toBeGreaterThan(0);
      expect(color.count).toBe(pos.count);
      expect(geometry.getIndex()!.count % 3).toBe(0);
      for (let i = 0; i < pos.count; i++) {
        expect(Number.isFinite(pos.getX(i))).toBe(true);
        expect(Number.isFinite(pos.getY(i))).toBe(true);
        expect(Number.isFinite(pos.getZ(i))).toBe(true);
        expect(pos.getY(i)).toBeGreaterThanOrEqual(-0.01);
      }
    }
  });
});

describe("buildFlora (real circuits)", () => {
  for (const entry of TRACKS) {
    it(`${entry.id} has a flora config with a real palette`, () => {
      const config = getFloraConfig(entry.id);
      expect(config).not.toBeNull();
      expect(config!.species.length).toBeGreaterThan(0);
      expect(config!.densityPerKm).toBeGreaterThan(0);
      for (const species of config!.species) {
        expect(species.canopyColors.length).toBeGreaterThan(0);
        for (const hex of [...species.canopyColors, species.trunkColor]) {
          expect(hex).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
      }
    });

    it(`${entry.id} builds a deterministic stand off the road`, () => {
      const track = getTrack(entry.id);
      const first = buildFlora(track);
      const second = buildFlora(track);
      const count = (builds: typeof first) =>
        builds.reduce((a, b) => a + b.instances.length, 0);
      expect(count(first)).toBeGreaterThan(100);
      expect(count(first)).toBeLessThan(3000);
      expect(JSON.stringify(second.map((b) => b.instances))).toBe(
        JSON.stringify(first.map((b) => b.instances))
      );

      const terrain = buildTerrainGeometry(track);
      const n = track.centerline.length;
      for (const build of first) {
        expect(build.colors.length).toBe(build.instances.length);
        for (let k = 0; k < build.instances.length; k++) {
          const inst = build.instances[k];
          // Palette membership (no invented colors).
          expect(
            getFloraConfig(entry.id)!.species[build.speciesIndex].canopyColors
          ).toContain(build.colors[k]);
          // Off the asphalt by the configured band.
          let best = Infinity;
          let bestI = 0;
          for (let i = 0; i < n; i += 2) {
            const dx = track.centerline[i][0] - inst.x;
            const dz = track.centerline[i][2] - inst.z;
            const d2 = dx * dx + dz * dz;
            if (d2 < best) {
              best = d2;
              bestI = i;
            }
          }
          const [cx, , cz] = track.centerline[bestI];
          const [px, , pz] = track.centerline[(bestI - 1 + n) % n];
          const [nx, , nz] = track.centerline[(bestI + 1) % n];
          const tx = nx - px;
          const tz = nz - pz;
          const len = Math.hypot(tx, tz) || 1;
          const lateral = Math.abs(((inst.x - cx) * -tz + (inst.z - cz) * tx) / len);
          expect(
            lateral,
            `${entry.id}: tree inside the asphalt`
          ).toBeGreaterThan(track.width[bestI] / 2 + 7);
          // Sitting on the ground, inside the field.
          const ground = sampleTerrainHeight(terrain, inst.x, inst.z);
          expect(ground).not.toBeNull();
          expect(Math.abs(inst.y + 0.4 - (ground ?? 0))).toBeLessThan(1.6);
        }
      }
    });
  }

  it("suzuka blossoms pink", () => {
    const track = getTrack("suzuka");
    const builds = buildFlora(track);
    const pink = new Set(["#E7A6C4", "#D98BB0", "#F0BCD4", "#C97B9E"]);
    let pinkCount = 0;
    let total = 0;
    for (const build of builds) {
      for (const hex of build.colors) {
        total++;
        if (pink.has(hex)) pinkCount++;
      }
    }
    // Cherry is the weighted majority species - most of the stand is pink.
    expect(pinkCount / total).toBeGreaterThan(0.5);
  });
});
