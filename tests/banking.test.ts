import { describe, expect, it } from "vitest";
import { bankingAt, bankedHeight, stationOf } from "../lib/tracks/banking";
import { buildRibbonGeometry, buildKerbGeometry, buildEdgeLineGeometry } from "../lib/tracks/mesh";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";

const DEG = Math.PI / 180;

// Turn direction in racingLine's own convention (behind.x*ahead.z -
// behind.z*ahead.x over a +-60m reach): positive is a right-hander -
// calibrated against Tarzan (T1, st ~440), which reads +0.94.
function turnAt(trackId: string, stationM: number): number {
  // racingLine's own convention (behind.x*ahead.z - behind.z*ahead.x over
  // a +-40m reach): positive is a right-hander - calibrated against
  // Tarzan (T1, st ~440), which reads +0.94.
  const track = getTrack(trackId);
  const n = track.centerline.length;
  const reach = 20;
  const i = Math.round((stationM / track.lengthMeters) * n) % n;
  const tang = (c: number) => {
    const p = track.centerline[(((c - 1) % n) + n) % n];
    const q = track.centerline[(c + 1) % n];
    const dx = q[0] - p[0];
    const dz = q[2] - p[2];
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  };
  const behind = tang(i - reach);
  const ahead = tang(i + reach);
  return behind.x * ahead.z - behind.z * ahead.x;
}

describe("bankingAt", () => {
  it("reads exactly zero for every circuit without an authored bank", () => {
    for (const entry of TRACKS) {
      if (entry.id === "zandvoort" || entry.id === "madrid") continue;
      const track = getTrack(entry.id);
      for (let s = 0; s < track.lengthMeters; s += 50) {
        expect(bankingAt(entry.id, s, track.lengthMeters)).toBe(0);
      }
    }
  });

  it("returns zero for unknown ids and degenerate laps", () => {
    expect(bankingAt("atlantis", 700, 4268)).toBe(0);
    expect(bankingAt("zandvoort", 780, 0)).toBe(0);
  });

  it("banks Zandvoort T3 to ~19 degrees", () => {
    const track = getTrack("zandvoort");
    const L = track.lengthMeters;
    expect(bankingAt("zandvoort", 780, L)).toBeCloseTo(-19 * DEG, 2);
  });

  it("banks Madring's fast corners and returns to flat on its straights", () => {
    const track = getTrack("madrid");
    const L = track.lengthMeters;
    expect(Math.abs(bankingAt("madrid", 250, L))).toBeGreaterThan(2 * DEG);
    expect(Math.abs(bankingAt("madrid", 1320, L))).toBeGreaterThan(2 * DEG);
    expect(Math.abs(bankingAt("madrid", 2500, L))).toBeGreaterThan(2 * DEG);
    for (const s of [0, 700, 1700, 3000, 4200, 5400]) {
      expect(Math.abs(bankingAt("madrid", s, L))).toBeLessThan(0.5 * DEG);
    }
  });

  it("leaves the final corner flat (deferred - see banking.ts)", () => {
    // The fast banked sweeper defeats the pursuit controller and both
    // attempted fixes moved the failure instead of removing it; banking it
    // waits for the controller work. Pinned at zero so a stray keyframe
    // can't silently re-bank it without updating this test.
    const track = getTrack("zandvoort");
    const L = track.lengthMeters;
    for (const s of [3730, 3850, 3985, 4020]) {
      expect(bankingAt("zandvoort", s, L)).toBe(0);
    }
  });

  it("is flat on Zandvoort's straights and closes cyclically", () => {
    const track = getTrack("zandvoort");
    const L = track.lengthMeters;
    for (const s of [0, 100, 2000, 3000, 4200]) {
      expect(bankingAt("zandvoort", s, L)).toBe(0);
    }
    expect(bankingAt("zandvoort", L, L)).toBeCloseTo(bankingAt("zandvoort", 0, L), 9);
    // Mid-ramp: cosine interpolation lands halfway between keyframes.
    expect(bankingAt("zandvoort", 695, L)).toBeCloseTo(-9.5 * DEG, 1);
  });

  it("lifts the outside edge: the banked corner is a right-hander", () => {
    // Positive banking raises the right edge (the outside of a left
    // turn). The banked corner must therefore read negative - and this
    // is checked against the turn direction measured from the built
    // centerline, not against a second hand-authored sign.
    const track = getTrack("zandvoort");
    const L = track.lengthMeters;
    expect(turnAt("zandvoort", 780)).toBeGreaterThan(0);
    expect(bankingAt("zandvoort", 780, L)).toBeLessThan(0);
  });
});

describe("banked geometry", () => {
  it("leaves unbanked ribbons exactly on the centerline plane", () => {
    const track = getTrack("silverstone");
    const ribbon = buildRibbonGeometry(track);
    for (let i = 0; i < track.centerline.length; i++) {
      // Float32 storage rounds the centerline's float64 y - compare
      // against the rounded value so the assertion pins "no banking
      // added" rather than float precision.
      expect(ribbon.positions[i * 6 + 1]).toBe(Math.fround(track.centerline[i][1]));
      expect(ribbon.positions[i * 6 + 4]).toBe(Math.fround(track.centerline[i][1]));
    }
  });

  it("raises Zandvoort's left edge through the banked corners", () => {
    const track = getTrack("zandvoort");
    const n = track.centerline.length;
    const ribbon = buildRibbonGeometry(track);
    // Station ~780 (T3): left edge up by sin(19deg)*halfWidth.
    const i = Math.round((780 / track.lengthMeters) * n) % n;
    const y = track.centerline[i][1];
    const halfW = track.width[i] / 2;
    const expect_ = Math.sin(19 * DEG) * halfW;
    expect(ribbon.positions[i * 6 + 1]).toBeCloseTo(y + expect_, 6);
    expect(ribbon.positions[i * 6 + 4]).toBeCloseTo(y - expect_, 6);
    expect(expect_).toBeGreaterThan(1);
  });

  it("keeps kerbs, edge lines and the racing line on the banked surface", () => {
    const track = getTrack("zandvoort");
    const n = track.centerline.length;
    const rightOf = (i: number) => {
      const p = track.centerline[(i - 1 + n) % n];
      const q = track.centerline[(i + 1) % n];
      const tx = q[0] - p[0];
      const tz = q[2] - p[2];
      const len = Math.hypot(tx, tz) || 1;
      return { x: -tz / len, z: tx / len };
    };
    // Racing line: each point's y is the banked height at its own lateral
    // offset from the centerline.
    const line = computeRacingLine(track);
    for (let k = 0; k < 40; k++) {
      const i = Math.floor((k / 40) * n);
      const [x, y, z] = line[i].position;
      const [cx, cy, cz] = track.centerline[i];
      const r = rightOf(i);
      const lateral = (x - cx) * r.x + (z - cz) * r.z;
      expect(y).toBeCloseTo(
        bankedHeight(track.id, stationOf(i, n, track.lengthMeters), track.lengthMeters, cy, lateral),
        9
      );
    }
    // Edge lines: every vertex sits at the banked height of its lateral
    // (the +3.5cm lift lives in Track.tsx, not the builder - see
    // buildEdgeLineGeometry).
    const edge = buildEdgeLineGeometry(track);
    for (let v = 0; v < edge.positions.length / 3; v += 37) {
      const i = Math.floor(v / 4) % n;
      const x = edge.positions[v * 3];
      const y = edge.positions[v * 3 + 1];
      const z = edge.positions[v * 3 + 2];
      const [cx, cy, cz] = track.centerline[i];
      const r = rightOf(i);
      const lateral = (x - cx) * r.x + (z - cz) * r.z;
      expect(y).toBeCloseTo(
        bankedHeight(track.id, stationOf(i, n, track.lengthMeters), track.lengthMeters, cy, lateral),
        2
      );
    }
    // Kerbs build without NaNs on a banked lap (placement/counts are the
    // surfaces suite's job - here only that banking didn't break them).
    const kerb = buildKerbGeometry(track);
    expect(kerb.positions.length).toBeGreaterThan(0);
    for (let k = 0; k < kerb.positions.length; k++) {
      expect(Number.isFinite(kerb.positions[k])).toBe(true);
    }
  });
});
