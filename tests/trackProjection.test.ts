import { describe, expect, it } from "vitest";
import {
  carScreenAngle,
  centerlineToPairs,
  createProjection,
  createTrackProjection,
  projectToCanvas,
  sampleTrackOutline,
  widestRibbon,
} from "../lib/tracks/trackProjection";
import silverstone from "../data/tracks/silverstone.json";
import { getOutline } from "../lib/tracks/preview";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import type { TrackData } from "../lib/tracks/types";

/**
 * The time attack draws a fixed, whole-circuit map. Two things have to be right
 * for it to be readable rather than decorative: the circuit must fit the box
 * undistorted at any aspect ratio (it is drawn on a phone and on a desktop),
 * and the car sprite must point the way the car is actually travelling, using
 * the game's own forward-vector convention.
 */

const track = silverstone as TrackData;
const BOX = 400;
/** A typical lap width, for the cases that only have an outline to draw. */
const ROAD_METERS = 12;

const outline = (t: TrackData) => sampleTrackOutline(centerlineToPairs(t), widestRibbon(t.width), createTrackProjection(t, BOX, BOX));

describe("createTrackProjection", () => {
  it("fits the circuit inside the box with the padding it asked for", () => {
    const p = createTrackProjection(track, BOX, BOX, 0.1);
    for (const [x, z] of [
      [p.minX, p.minZ],
      [p.maxX, p.minZ],
      [p.minX, p.maxZ],
      [p.maxX, p.maxZ],
    ]) {
      const s = projectToCanvas(p, x, z);
      expect(s.x).toBeGreaterThanOrEqual(BOX * 0.1 - 1e-6);
      expect(s.x).toBeLessThanOrEqual(BOX * 0.9 + 1e-6);
      expect(s.y).toBeGreaterThanOrEqual(BOX * 0.1 - 1e-6);
      expect(s.y).toBeLessThanOrEqual(BOX * 0.9 + 1e-6);
    }
  });

  it("uses one scale for both axes, so the circuit's shape is never stretched", () => {
    // A wide, short box is where a per-axis scale would visibly lie: the
    // circuit would be squashed flat to fill the width. The invariant is that
    // the projected shape keeps the real aspect ratio, whatever the box.
    for (const [w, h] of [[900, 200], [200, 900], [400, 400], [1000, 260]] as const) {
      const p = createTrackProjection(track, w, h);
      const worldAspect = (p.maxX - p.minX) / (p.maxZ - p.minZ);
      const screenAspect = ((p.maxX - p.minX) * p.scale) / ((p.maxZ - p.minZ) * p.scale);
      expect(screenAspect, `${w}x${h}`).toBeCloseTo(worldAspect, 12);
    }
  });

  it("grows the scale with a larger box, so the circuit uses the space it is given", () => {
    const small = createTrackProjection(track, 200, 200);
    const large = createTrackProjection(track, 800, 800);
    expect(large.scale).toBeGreaterThan(small.scale);
  });

  it("centres the circuit, so the margins are equal on every side", () => {
    const p = createTrackProjection(track, BOX, BOX, 0.08);
    const left = projectToCanvas(p, p.minX, 0).x;
    const right = projectToCanvas(p, p.maxX, 0).x;
    expect(left).toBeCloseTo(BOX - right, 6);
    const top = projectToCanvas(p, 0, p.minZ).y;
    const bottom = projectToCanvas(p, 0, p.maxZ).y;
    expect(top).toBeCloseTo(BOX - bottom, 6);
  });

  it("keeps every centerline point on screen for every circuit in the roster", () => {
    for (const meta of TRACKS) {
      const t = getTrack(meta.id);
      const p = createTrackProjection(t, 360, 240);
      for (let i = 0; i < t.centerline.length; i += 7) {
        const [x, , z] = t.centerline[i];
        const s = projectToCanvas(p, x, z);
        expect(Number.isFinite(s.x), `${meta.id} x`).toBe(true);
        expect(Number.isFinite(s.y), `${meta.id} z`).toBe(true);
        // The scale is fitted to the bounds, so a point lands exactly on the
        // edge at worst.
        expect(s.x, `${meta.id} x`).toBeGreaterThan(-1);
        expect(s.x, `${meta.id} x`).toBeLessThan(361);
        expect(s.y, `${meta.id} z`).toBeGreaterThan(-1);
        expect(s.y, `${meta.id} z`).toBeLessThan(241);
      }
    }
  });

  it("reports the lap length it was built from", () => {
    expect(createTrackProjection(track, BOX, BOX).lengthMeters).toBe(track.lengthMeters);
  });

  it("returns a usable projection for a circuit with no centerline", () => {
    // Degenerate data must not produce a NaN scale and blank the canvas.
    const p = createProjection([], BOX, BOX);
    expect(Number.isFinite(p.scale)).toBe(true);
    const s = projectToCanvas(p, 100, 100);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Number.isFinite(s.y)).toBe(true);
  });
});

describe("carScreenAngle", () => {
  it("points the car up the screen at yaw 0, matching the game's -Z forward", () => {
    // A sprite drawn pointing along +X has to be rotated a quarter turn
    // anticlockwise to point up. Forward at yaw 0 is (-sin 0, -cos 0) = (0,-1),
    // which is up on a screen whose Y axis follows world Z unflipped.
    expect(carScreenAngle(0)).toBeCloseTo(-Math.PI / 2, 6);
  });

  it.each([0, 0.7, -0.7, Math.PI / 2, -Math.PI / 2, Math.PI, 2.9, -2.9])(
    "aims the sprite along the car's real forward vector (yaw=%f)",
    (yaw) => {
      // The forward vector the game itself uses: (-sin yaw, -cos yaw).
      const angle = carScreenAngle(yaw);
      expect(Math.cos(angle)).toBeCloseTo(-Math.sin(yaw), 6);
      expect(Math.sin(angle)).toBeCloseTo(-Math.cos(yaw), 6);
    }
  );

  it("agrees with the race's own minimap about which way is forward", () => {
    // The two views are different transforms of the same convention. If these
    // ever disagreed, the time attack map would show the car driving backwards
    // while the race HUD showed it driving forwards.
    const yaw = 1.234;
    const p = createTrackProjection(track, BOX, BOX);
    const carX = 12;
    const carZ = -30;
    const here = projectToCanvas(p, carX, carZ);
    const ahead = projectToCanvas(p, carX - Math.sin(yaw) * 50, carZ - Math.cos(yaw) * 50);
    const aheadAngle = Math.atan2(ahead.y - here.y, ahead.x - here.x);
    const angle = carScreenAngle(yaw);
    const delta = Math.atan2(Math.sin(aheadAngle - angle), Math.cos(aheadAngle - angle));
    expect(Math.abs(delta)).toBeLessThan(1e-6);
  });
});

describe("sampleTrackOutline", () => {
  it("starts at the start/finish point so the line marker lands correctly", () => {
    const p = createTrackProjection(track, BOX, BOX);
    const sampled = outline(track);
    const start = projectToCanvas(p, track.centerline[0][0], track.centerline[0][2]);
    expect(sampled.points[0].x).toBeCloseTo(start.x, 6);
    expect(sampled.points[0].y).toBeCloseTo(start.y, 6);
  });

  it("includes the start point even when the stride would skip it", () => {
    const p = createTrackProjection(track, BOX, BOX);
    const pairs = centerlineToPairs(track);
    for (const stride of [2, 3, 7, 1000]) {
      const sampled = sampleTrackOutline(pairs, ROAD_METERS, p, stride);
      const start = projectToCanvas(p, pairs[0][0], pairs[0][1]);
      const first = sampled.points[0];
      expect(Math.hypot(first.x - start.x, first.y - start.y), `stride ${stride}`).toBeLessThan(0.5);
    }
  });

  it("decimates without losing the shape", () => {
    const p = createTrackProjection(track, BOX, BOX);
    const pairs = centerlineToPairs(track);
    const full = sampleTrackOutline(pairs, ROAD_METERS, p, 1);
    const lean = sampleTrackOutline(pairs, ROAD_METERS, p, 4);
    expect(lean.points.length).toBeLessThan(full.points.length);
    // Still a few hundred points, so the ribbon reads as smooth rather than
    // faceted, and every point is finite.
    expect(lean.points.length).toBeGreaterThan(100);
    for (const pt of lean.points) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    }
  });

  it("clamps a stride below 1 instead of looping forever", () => {
    const p = createTrackProjection(track, BOX, BOX);
    const pairs = centerlineToPairs(track);
    for (const stride of [0, -5, 0.4]) {
      const sampled = sampleTrackOutline(pairs, ROAD_METERS, p, stride);
      expect(sampled.points.length).toBeGreaterThan(0);
      expect(sampled.points.length).toBeLessThanOrEqual(pairs.length + 1);
    }
  });

  it("reports a road width that is visible on a narrow circuit and not overwhelming on a wide one", () => {
    const p = createTrackProjection(track, BOX, BOX);
    const narrow = sampleTrackOutline(centerlineToPairs(track), 6, p);
    const wide = sampleTrackOutline(centerlineToPairs(track), 20, p);
    expect(narrow.roadWidthPx).toBeGreaterThanOrEqual(3);
    expect(wide.roadWidthPx).toBeLessThanOrEqual(26);
    expect(wide.roadWidthPx).toBeGreaterThanOrEqual(narrow.roadWidthPx);
  });

  it("finds the real ribbon width", () => {
    expect(widestRibbon(track.width)).toBe(Math.max(...track.width));
    expect(widestRibbon([])).toBe(0);
  });

  it("draws the light outline sidecar in the same place as the full centerline", () => {
    // The landing page draws the ~54KB outline before the ~200KB centerline has
    // loaded. If the two did not agree, the map would visibly jump the moment
    // the car became drivable.
    const full = createTrackProjection(track, BOX, BOX);
    const light = createProjection(getOutline("silverstone").points, BOX, BOX);
    expect(light.scale).toBeCloseTo(full.scale, 3);
    for (const [x, z] of [
      [0, 0],
      [full.minX, full.minZ],
      [full.maxX, full.maxZ],
    ]) {
      const a = projectToCanvas(full, x, z);
      const b = projectToCanvas(light, x, z);
      expect(b.x).toBeCloseTo(a.x, 0);
      expect(b.y).toBeCloseTo(a.y, 0);
    }
  });

  it("stays sane on a very differently shaped circuit", () => {
    // Monaco is the roster's tightest street circuit, and a poor projection
    // shows up there first.
    const t = getTrack("monaco");
    const sampled = outline(t);
    expect(sampled.points.length).toBeGreaterThan(50);
    for (const pt of sampled.points) {
      expect(Number.isFinite(pt.x)).toBe(true);
      expect(Number.isFinite(pt.y)).toBe(true);
    }
  });
});
