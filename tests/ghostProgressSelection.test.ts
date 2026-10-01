import { describe, expect, it } from "vitest";
import {
  deltaToGhost,
  ghostSectorSplit,
  ghostTimeAt,
  projectGhostToProgress,
} from "../lib/race/ghostProgress";
import {
  ghostChoiceStorageValue,
  ghostChoices,
  resolveGhostChoice,
  type GhostChoiceId,
} from "../lib/race/ghostSelection";
import type { TrackData } from "../lib/tracks/types";
import type { GhostSample } from "../lib/race/ghostRecorder";
import { validateGhostUpload, expectedGhostSampleCount } from "../lib/race/ghostUploadGuard";
import { decodeGhost, encodeGhost, type GhostCodecError } from "../lib/race/ghostCodec";

function isError(v: unknown): v is GhostCodecError {
  return typeof v === "object" && v !== null && "reason" in v;
}

/**
 * Roadmap 11.9: projecting a ghost onto the progress axis, and the picker that
 * decides which ghost you race.
 *
 * The projection is the interesting half. A ghost arrives as world positions
 * stamped with time; the delta timer needs the reference indexed by distance
 * along the track. The bug this guards against is the start/finish seam, where
 * a naive nearest-point projection makes a ghost at 99% of the lap read as 1%,
 * spiking the delta once a lap for no reason.
 */

/**
 * A square circuit whose centerline points are spaced UNIFORMLY BY ARC
 * LENGTH, with no duplicated corner points.
 *
 * That uniformity is load-bearing rather than cosmetic: trackProgress derives
 * progress from the centerline INDEX ((i/n) * length), so if the points were
 * not equally spaced then index-fraction and arc-length would disagree and
 * every timing assertion here would be measuring the fixture's irregularity
 * instead of the code under test.
 */
function squareTrack(lengthMeters = 1000, points = 64): TrackData {
  const side = lengthMeters / 4;
  const half = side / 2;
  const cl: [number, number, number][] = [];
  for (let i = 0; i < points; i += 1) {
    const s = (i / points) * lengthMeters;
    const leg = Math.floor(s / side);
    const f = (s - leg * side) / side;
    if (leg === 0) cl.push([-half + f * side, 0, -half]);
    else if (leg === 1) cl.push([half, 0, -half + f * side]);
    else if (leg === 2) cl.push([half - f * side, 0, half]);
    else cl.push([-half, 0, half - f * side]);
  }
  return {
    id: "test",
    name: "Test",
    lengthMeters,
    centerline: cl,
    width: cl.map(() => 12),
    startPos: { x: -half, z: -half, headingRad: 0 },
  };
}

/** Drives the square circuit, `seconds` long, at `hz`. */
function squareLap(track: TrackData, seconds: number, hz = 20): GhostSample[] {
  const n = track.centerline.length;
  const samples: GhostSample[] = [];
  for (let i = 0; i <= Math.round(seconds * hz); i += 1) {
    const t = i / hz;
    // Walk the centerline at a constant fraction of it per second.
    const f = (t / seconds) * n;
    const idx = Math.min(n - 1, Math.floor(f));
    const frac = f - idx;
    const a = track.centerline[idx];
    const b = track.centerline[(idx + 1) % n];
    samples.push({
      elapsedSeconds: t,
      position: {
        x: a[0] + (b[0] - a[0]) * frac,
        y: 0,
        z: a[2] + (b[2] - a[2]) * frac,
      },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    });
  }
  return samples;
}

describe("projecting a ghost onto the progress axis", () => {
  const track = squareTrack(1000);

  it("produces a trace spanning the whole lap", () => {
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60);
    expect(trace).not.toBeNull();
    if (!trace) return;
    expect(trace.progressMeters[0]).toBe(0);
    // The closing point is forced to the exact length - at the line a
    // nearest-point search is a coin toss between ~0 and ~length, and the
    // trace's tail has to interpolate to the true lap time.
    expect(trace.progressMeters[trace.progressMeters.length - 1]).toBe(1000);
    expect(trace.elapsedSeconds[trace.elapsedSeconds.length - 1]).toBeCloseTo(60, 1);
  });

  it("does not flip across the start/finish seam", () => {
    // THE test. Progress must be non-decreasing across the whole lap,
    // including where the car crosses the line. A naive nearest-point
    // projection sends it from ~999m back to ~0m here, which would spike the
    // delta once a lap.
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60);
    if (!trace) throw new Error("no trace");
    for (let i = 1; i < trace.progressMeters.length; i += 1) {
      expect(trace.progressMeters[i]).toBeGreaterThanOrEqual(trace.progressMeters[i - 1] - 1e-6);
    }
  });

  it("rejects a trace too short to project", () => {
    // Three samples is the floor; below that a projection would read as
    // plausible and be meaningless, which is worse than no delta.
    expect(projectGhostToProgress(track, [], 60)).toBeNull();
    expect(projectGhostToProgress(track, squareLap(track, 60).slice(0, 2), 60)).toBeNull();
    expect(projectGhostToProgress(track, squareLap(track, 60), 0)).toBeNull();
    expect(projectGhostToProgress(track, squareLap(track, 60), NaN)).toBeNull();
  });
});

describe("delta to a ghost", () => {
  const track = squareTrack(1000);
  const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;

  it("is zero when running exactly the reference's pace", () => {
    for (const p of [100, 250, 500, 750, 900]) {
      const d = deltaToGhost(trace, p, ghostTimeAt(trace, p)!);
      expect(d).not.toBeNull();
      expect(Math.abs(d!)).toBeLessThan(0.05);
    }
  });

  it("is positive when behind, negative when ahead", () => {
    const at = 500;
    const reference = ghostTimeAt(trace, at)!;
    // The sign the HUD colours by: positive = behind.
    expect(deltaToGhost(trace, at, reference + 1.5)!).toBeGreaterThan(0);
    expect(deltaToGhost(trace, at, reference - 1.5)!).toBeLessThan(0);
  });

  it("clamps outside the ghost's span rather than extrapolating", () => {
    // Before the ghost's first sample and after its last, hold the endpoint.
    // Extrapolating would report a growing fake gap for a car that is simply
    // not on the same part of the track yet.
    expect(ghostTimeAt(trace, -50)).toBe(trace.elapsedSeconds[0]);
    expect(ghostTimeAt(trace, 5000)).toBe(trace.elapsedSeconds[trace.elapsedSeconds.length - 1]);
  });
});

describe("sector splits from a ghost", () => {
  const track = squareTrack(1000);

  it("reads cumulative splits at the gates", () => {
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;
    const split = ghostSectorSplit(track, trace, 3, [250, 500, 750]);
    expect(split).not.toBeNull();
    if (!split) return;
    // 60s over 1000m is even pace, so each of the three sectors is a third of
    // the lap: 15s apiece, with the gates at 15/30/45.
    for (const s of split.sectorSeconds) expect(s).toBeCloseTo(15, 0);
    expect(split.cumulativeSeconds).toHaveLength(3);
    expect(split.cumulativeSeconds[0]).toBeCloseTo(15, 0);
    expect(split.cumulativeSeconds[1]).toBeCloseTo(30, 0);
    expect(split.cumulativeSeconds[2]).toBeCloseTo(45, 0);
  });

  it("rejects gates that do not increase, rather than emitting a negative sector", () => {
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;
    // A gate at 0m would produce a negative first sector.
    expect(ghostSectorSplit(track, trace, 2, [0, 500])).toBeNull();
    expect(ghostSectorSplit(track, trace, 2, [500, 500])).toBeNull();
    expect(ghostSectorSplit(track, trace, 2, [500, 99999])).toBeNull();
  });

  it("rejects a sector count the gates do not cover", () => {
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;
    expect(ghostSectorSplit(track, trace, 3, [250, 500])).toBeNull();
    expect(ghostSectorSplit(track, trace, 0, [])).toBeNull();
  });

  it("survives the real upload pipeline: encode, decode, project, guard", async () => {
    // The whole path a server would run, and the test that actually pins the
    // three modules together. Each stage hands the next a DIFFERENT
    // representation, and the bug this catches is a disagreement between them:
    // the codec resamples to 10Hz, the guard measures duration from that 10Hz
    // sample count, and the projection measures travel along the centerline.
    // If any two of those definitions drifted apart, we would end up rejecting
    // our own honest ghosts - a failure that could not show up until storage
    // existed and real blobs started coming back.
    const seconds = 60;
    const encoded = await encodeGhost(squareLap(track, seconds), track.centerline, seconds * 1000);
    if (isError(encoded)) throw new Error(encoded.reason);
    const decoded = await decodeGhost(encoded);
    if (isError(decoded)) throw new Error(decoded.reason);
    const trace = projectGhostToProgress(track, decoded.samples, decoded.lapMs / 1000)!;

    const verdict = validateGhostUpload({
      lapSeconds: decoded.lapMs / 1000,
      sectorSeconds: [],
      sampleCount: decoded.samples.length,
      progressMeters: trace.progressMeters,
      trackLengthMeters: trace.trackLengthMeters,
    });
    if (!verdict.ok) throw new Error(`guard rejected our own trace: ${verdict.reason}`);
    // And the decoded trace really is on the 10Hz grid the guard assumes.
    expect(decoded.samples.length).toBe(expectedGhostSampleCount(seconds));
    expect(trace.progressMeters[trace.progressMeters.length - 1]).toBeCloseTo(1000, 0);
  });

  it("produces travel the upload guard accepts", () => {
    // Cross-module consistency on the travel axis specifically: the guard
    // measures travel as (last - first) projected progress, so the projection
    // and the guard have to agree on what one lap of travel is.
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;
    const travelled = Math.abs(
      trace.progressMeters[trace.progressMeters.length - 1] - trace.progressMeters[0]
    );
    expect(travelled).toBeCloseTo(trace.trackLengthMeters, 0);
  });

  it("produces splits the upload guard would accept", () => {
    // The two halves have to agree: a ghost's sector split is the same shape
    // the guard validates on upload, so an inconsistency here would mean we
    // could generate a blob our own guard rejects.
    const trace = projectGhostToProgress(track, squareLap(track, 60), 60)!;
    const split = ghostSectorSplit(track, trace, 3, [250, 500, 750]);
    if (!split) throw new Error("no split");
    for (let i = 1; i < split.cumulativeSeconds.length; i += 1) {
      expect(split.cumulativeSeconds[i]).toBeGreaterThan(split.cumulativeSeconds[i - 1]);
    }
    // Cumulative, so the last gate (750m of a 1000m lap) is three quarters of
    // the lap rather than the whole thing - reconciling the split against the
    // lap total is the upload guard's job, not this function's.
    expect(split.cumulativeSeconds[split.cumulativeSeconds.length - 1]).toBeCloseTo(45, 0);
    expect(trace.lapSeconds).toBe(60);
  });
});

describe("choosing which ghost to race", () => {
  const withPb = { personalBestSeconds: 88.5, rivalGhost: null, worldRecordGhost: null };

  it("marks the personal best available and the shared ones not", () => {
    const choices = ghostChoices(withPb);
    const byId = Object.fromEntries(choices.map((c) => [c.id, c]));
    expect(byId["personal-best"].available).toBe(true);
    expect(byId["personal-best"].lapSeconds).toBe(88.5);
    expect(byId.rival.available).toBe(false);
    expect(byId["world-record"].available).toBe(false);
  });

  it("states why a shared ghost is unavailable instead of a bare 'coming soon'", () => {
    // The reason is specific - there is nowhere to store one - and a player
    // deserves that rather than a vague promise.
    const rival = ghostChoices(withPb).find((c) => c.id === "rival");
    expect(rival?.unavailableReason).toMatch(/store/i);
  });

  it("marks the personal best unavailable when there is no lap yet", () => {
    const choices = ghostChoices({ personalBestSeconds: null, rivalGhost: null, worldRecordGhost: null });
    const pb = choices.find((c) => c.id === "personal-best");
    expect(pb?.available).toBe(false);
    expect(pb?.unavailableReason).toMatch(/set a lap/i);
  });

  it("enables the shared options the moment a ghost is supplied", () => {
    // The whole point of deriving the list: when the storage exists, this
    // function needs no change, only a fetch feeding the input.
    const choices = ghostChoices({
      personalBestSeconds: 88.5,
      rivalGhost: { lapSeconds: 87.2, attribution: "LEC" },
      worldRecordGhost: null,
    });
    const rival = choices.find((c) => c.id === "rival");
    expect(rival?.available).toBe(true);
    expect(rival?.lapSeconds).toBe(87.2);
    expect(rival?.attribution).toBe("LEC");
  });

  it("falls back to the personal best when the request is unavailable", () => {
    // A silent fallback on purpose: a player who asked for a rival and got no
    // ghost at all would be worse off than one quietly racing their own PB.
    const choices = ghostChoices(withPb);
    expect(resolveGhostChoice(choices, "rival")?.id).toBe("personal-best");
    expect(resolveGhostChoice(choices, "world-record")?.id).toBe("personal-best");
  });

  it("honours a request that IS available", () => {
    const choices = ghostChoices({
      personalBestSeconds: 88.5,
      rivalGhost: { lapSeconds: 87.2, attribution: "LEC" },
      worldRecordGhost: { lapSeconds: 84.0, attribution: "VER" },
    });
    expect(resolveGhostChoice(choices, "rival")?.id).toBe("rival");
    expect(resolveGhostChoice(choices, "world-record")?.id).toBe("world-record");
  });

  it("returns null when there is no ghost at all, rather than a broken default", () => {
    const choices = ghostChoices({ personalBestSeconds: null, rivalGhost: null, worldRecordGhost: null });
    expect(resolveGhostChoice(choices, "personal-best")).toBeNull();
    expect(resolveGhostChoice(choices, null)).toBeNull();
  });

  it("persists only an available choice", () => {
    // An unavailable id in localStorage would resolve to a fallback on the
    // next load, so it is never written in the first place.
    const choices = ghostChoices(withPb);
    const id: GhostChoiceId = "rival";
    const resolved = resolveGhostChoice(choices, id);
    expect(ghostChoiceStorageValue(resolved)).toBe("personal-best");
    expect(ghostChoiceStorageValue(null)).toBeNull();
    expect(ghostChoiceStorageValue(choices.find((c) => c.id === "rival")!)).toBeNull();
  });
});
