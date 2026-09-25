import { describe, expect, it } from "vitest";
import { simulateDrive } from "../lib/ai/harness";
import { getTrack } from "../lib/tracks/trackData";
import { TRACKS } from "../lib/tracks/registry";
import { buildBarrierWallMesh, buildBarrierWalls } from "../lib/tracks/structures";
import { buildTerrainGeometry } from "../lib/tracks/terrain";
import { checkTrackLimits } from "../lib/tracks/trackLimits";
import { sampleSurface } from "../lib/tracks/surfaces";
import { barrierProfileForTrack, hasGravelTraps, runoffKindForTrack } from "../lib/tracks/environment";

/**
 * The barrier line is the one piece of trackside geometry that is physical
 * (see lib/tracks/environment.ts and the BarrierWalls component in
 * app/race/Track.tsx). Before it had a collider at all, a car drove through
 * every wall on every circuit at any speed. These tests pin the two
 * properties that make solid walls safe to ship:
 *
 *  1. No wall is ever placed on - or too near - the racing surface, on any
 *     circuit. Otherwise the AI (which has no edge perception) would be
 *     driving into walls the player cannot see either.
 *  2. A car at racing speed is actually stopped by a wall rather than
 *     tunnelling through it. This is the anti-tunnelling regression: the
 *     collider is deliberately far thicker than the visible barrier, because
 *     at 80 m/s the car covers ~1.4m per 1/60s step and a realistically thin
 *     0.5m armco would simply be driven through.
 */

const ALL = TRACKS.map((meta) => getTrack(meta.id));

/** A point `meters` past the painted edge at centerline station `i`. */
function offTrackPoint(track: (typeof ALL)[number], i: number, meters: number): [number, number] {
  const n = track.centerline.length;
  const c = track.centerline[i];
  const before = track.centerline[(i - 1 + n) % n];
  const after = track.centerline[(i + 1) % n];
  const tx = after[0] - before[0];
  const tz = after[2] - before[2];
  const len = Math.hypot(tx, tz) || 1;
  const half = track.width[i] / 2;
  const offset = half + meters;
  return [c[0] + (-tz / len) * offset, c[2] + (tx / len) * offset];
}

describe("barrier walls", () => {
  it("exist on every circuit", () => {
    for (const track of ALL) {
      const walls = buildBarrierWalls(track, buildTerrainGeometry(track));
      expect(walls.boxes.length, `${track.id} has no barrier boxes`).toBeGreaterThan(100);
    }
  });

  it("never come closer than the minimum run-off to the racing surface", () => {
    for (const track of ALL) {
      const walls = buildBarrierWalls(track, buildTerrainGeometry(track));
      // The nearest point of any wall to the painted edge, measured with the
      // same projection the track-limit penalty uses.
      expect(
        walls.minimumSetbackMeters,
        `${track.id} places a wall inside the run-off`
      ).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("keep every wall box entirely off the racing surface", () => {
    for (const track of ALL) {
      const walls = buildBarrierWalls(track, buildTerrainGeometry(track));
      for (const box of walls.boxes) {
        const status = checkTrackLimits(track, box.cx, box.cz, box.cy);
        expect(
          status.isOffTrack,
          `${track.id} has a wall box on the racing surface`
        ).toBe(true);
      }
    }
  });

  it("sit at each circuit's own run-off setback, not one global distance", () => {
    // Monza's run-off after T1 and a Monaco hotel wall are not the same
    // distance apart; a single global offset would be wrong for one of them.
    const monza = barrierProfileForTrack("monza").setbackMeters;
    const monaco = barrierProfileForTrack("monaco").setbackMeters;
    expect(monza).toBeGreaterThan(20);
    expect(monaco).toBeLessThan(8);
    // An unlisted circuit still gets a sensible default rather than zero.
    expect(barrierProfileForTrack("not-a-real-track").setbackMeters).toBeGreaterThan(10);
  });

  it("is thick enough that a car cannot cross it in one physics step", () => {
    // Measured straight-line top speed in tests/gearbox.test.ts is low-80s
    // m/s; low-drag aero has a theoretical ceiling near 104. At 1/60s that
    // is ~1.7m of travel per step, so the slab has to be comfortably wider.
    const perStepAtTopSpeedMeters = 90 / 60;
    for (const track of ALL) {
      const profile = barrierProfileForTrack(track.id);
      expect(
        profile.halfThicknessMeters * 2,
        `${track.id}'s wall is thin enough to tunnel at racing speed`
      ).toBeGreaterThan(perStepAtTopSpeedMeters * 2);
    }
  });

  it("builds one mergeable mesh the app and the harness can share", () => {
    for (const track of ALL.slice(0, 6)) {
      const mesh = buildBarrierWallMesh(track, buildTerrainGeometry(track));
      expect(mesh.boxCount).toBeGreaterThan(100);
      expect(mesh.positions.length).toBe(mesh.boxCount * 8 * 3);
      expect(mesh.indices.length).toBe(mesh.boxCount * 12 * 3);
      for (let i = 0; i < mesh.positions.length; i++) {
        expect(Number.isFinite(mesh.positions[i])).toBe(true);
      }
    }
  });
});

describe("barrier walls stop a car", () => {
  /**
   * Launch a car at a wall's near face at `speedMs`, aimed along the wall's
   * outward normal, and report how much of that speed survived.
   */
  async function hitWall(trackId: string, speedMs: number) {
    const track = getTrack(trackId);
    const walls = buildBarrierWalls(track, buildTerrainGeometry(track));
    // A box on a straight, well away from the pit straight so the approach
    // is clean: pick one whose two neighbours are nearly collinear.
    let box = walls.boxes[0];
    for (const candidate of walls.boxes) {
      box = candidate;
      if (candidate.cx * candidate.cx + candidate.cz * candidate.cz > 40000) break;
    }
    // +90deg from the box's along-track axis is its outward normal.
    const nx = Math.sin(box.yaw + Math.PI / 2);
    const nz = Math.cos(box.yaw + Math.PI / 2);
    const approachMeters = 25;
    const spawn = {
      x: box.cx - nx * (box.hz + approachMeters),
      z: box.cz - nz * (box.hz + approachMeters),
      headingRad: Math.atan2(nx, nz),
      speedMs,
    };
    // The setback at THIS box, not the track-wide minimum: the minimum is
    // governed by some hairpin elsewhere on the lap, and comparing a contact
    // on a 20m-run-off straight against a 10.9m minimum would fail for the
    // wrong reason.
    const localSetback =
      checkTrackLimits(track, box.cx, box.cz, box.cy).distanceFromEdgeMeters - box.hz;
    let finalSpeed = 0;
    let furthestOff = 0;
    await simulateDrive(
      6,
      () => ({ throttle: 0, brake: 0, steer: 0 }),
      {
        track,
        spawn,
        engineForce: 0,
        brakeForce: 0,
        stabilizeStrength: 0,
        onTelemetry: (sample) => {
          const status = checkTrackLimits(track, sample.position.x, sample.position.z, sample.position.y);
          furthestOff = Math.max(furthestOff, status.distanceFromEdgeMeters);
          finalSpeed = Math.abs(sample.speedMs);
        },
      }
    );
    return { finalSpeed, furthestOff, setback: localSetback };
  }

  it("stops a car arriving at 80 m/s rather than letting it through", async () => {
    for (const id of ["silverstone", "monza", "spa", "suzuka"]) {
      const result = await hitWall(id, 80);
      // Stopped: the launch speed is gone, not just reduced.
      expect(
        result.finalSpeed,
        `${id}: car was still travelling after 6s, so it went through the barrier`
      ).toBeLessThan(6);
      // And it never got past the wall it was aimed at. The car nose is ~2m
      // long, so a couple of metres of overshoot at the contact is expected;
      // tunnelling would put it tens of metres out.
      expect(
        result.furthestOff,
        `${id}: car ended up beyond the barrier`
      ).toBeLessThan(result.setback + 6);
    }
  }, 600_000);

  it("loses more speed the harder it is driven into", async () => {
    const slow = await hitWall("silverstone", 25);
    const fast = await hitWall("silverstone", 80);
    expect(fast.finalSpeed).toBeLessThanOrEqual(slow.finalSpeed + 0.5);
  }, 600_000);
});

describe("per-track run-off", () => {
  it("never lets a sealed-runoff circuit fall through to grass", () => {
    // An environment-table kind that surfaces.ts does not handle falls
    // through to grass - and grass is grippier than sealed run-off, so the
    // circuit quietly gets a faster, drag-free run-off. Monaco's Ace
    // standing-start benchmark lost its margin over Pro to exactly this.
    // Scan the whole lap: a single probe point can sit inside a
    // curvature-derived gravel zone and prove nothing.
    for (const track of ALL) {
      const kind = runoffKindForTrack(track.id);
      if (kind !== "paved" && kind !== "concrete") continue;
      const n = track.centerline.length;
      let sealedStations = 0;
      for (let i = 0; i < n; i += 5) {
        const [x, z] = offTrackPoint(track, i, 40);
        const surface = sampleSurface(track, x, z).surface;
        expect(
          surface,
          `${track.id} is "${kind}" run-off but classified "${surface}" at station ${i}`
        ).not.toBe("grass");
        if (surface === "paved") sealedStations++;
      }
      expect(
        sealedStations,
        `${track.id}: no station ever classified its run-off as sealed`
      ).toBeGreaterThan(0);
    }
  });

  it("gives every circuit a run-off surface, and gravel where it belongs", () => {
    for (const track of ALL) {
      // Every circuit has SOMETHING past the kerb - that was the ask.
      expect(runoffKindForTrack(track.id)).toBeTruthy();
    }
    // Street circuits genuinely have no gravel; saying otherwise would be
    // inventing scenery that does not exist.
    for (const id of ["monaco", "singapore", "baku", "lasvegas"]) {
      expect(hasGravelTraps(id), `${id} should not have gravel traps`).toBe(false);
      expect(runoffKindForTrack(id)).not.toBe("gravel");
    }
    // Desert circuits do.
    for (const id of ["bahrain", "lusail"]) {
      expect(hasGravelTraps(id)).toBe(true);
      expect(runoffKindForTrack(id)).toBe("gravel");
    }
    // And the permanent circuits have the real thing.
    for (const id of ["monza", "silverstone", "spa", "suzuka", "spielberg"]) {
      expect(hasGravelTraps(id), `${id} should have gravel traps`).toBe(true);
    }
  });

  it("gives the street circuits their fences and concrete walls", () => {
    expect(barrierProfileForTrack("lasvegas").catchFence).toBe(true);
    expect(barrierProfileForTrack("singapore").catchFence).toBe(true);
    expect(barrierProfileForTrack("monaco").style).toBe("concrete");
    expect(barrierProfileForTrack("monaco").catchFence).toBe(false);
    // A permanent circuit has no catch fence - the run-off is the barrier.
    expect(barrierProfileForTrack("monza").catchFence).toBe(false);
  });
});
