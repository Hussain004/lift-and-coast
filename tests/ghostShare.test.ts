import { describe, expect, it } from "vitest";
import { loadSharedGhost, prepareGhostUpload, shareGhost } from "../lib/race/ghostShare";
import { bytesToBase64 } from "../lib/race/sharedGhosts";
import type { TrackData } from "../lib/tracks/types";
import type { GhostSample } from "../lib/race/ghostRecorder";

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


const config = { url: "https://x.supabase.co", publishableKey: "pk" };
const LAP = "123e4567-e89b-42d3-a456-426614174000";

function fetchWith(handlers: { info?: unknown; trace?: string; post?: boolean }) {
  const posts: unknown[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return { ok: handlers.post ?? true, json: async () => [] } as Response;
    }
    const body = url.includes("select=trace") ? [{ trace: handlers.trace }] : handlers.info;
    return { ok: true, json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

describe("sharing a ghost", () => {
  const track = squareTrack(1000);

  it("encodes a genuine lap, and rejects one that does not match its claimed time", async () => {
    const ok = await prepareGhostUpload(track, squareLap(track, 60, 60), 60000);
    expect("bytes" in ok).toBe(true);
    // A 30 s trace claiming a 20 s lap fails the duration check.
    const bad = await prepareGhostUpload(track, squareLap(track, 30, 60), 20000);
    expect("error" in bad).toBe(true);
  });

  it("uploads only after the lap row is posted, and not at all if that fails", async () => {
    const f = fetchWith({});
    const common = {
      config,
      track,
      samples: squareLap(track, 60, 60),
      lapMs: 60000,
      lapId: LAP,
      driverCode: "GAS",
      clientId: LAP,
      transport: { fetchImpl: f.fetchImpl },
    };
    expect(await shareGhost({ ...common, lapPosted: Promise.resolve(false) })).toBe(false);
    expect(f.posts).toHaveLength(0);
    expect(await shareGhost({ ...common, lapPosted: Promise.resolve(true) })).toBe(true);
    expect(f.posts).toHaveLength(1);
  });

  it("downloads a ghost that checks out, and refuses one whose time is a lie", async () => {
    const prepared = await prepareGhostUpload(track, squareLap(track, 60, 60), 60000);
    if (!("bytes" in prepared)) throw new Error("fixture lap should encode");
    const trace = bytesToBase64(prepared.bytes);
    const truthful = fetchWith({ info: [{ lap_id: LAP, lap_ms: 60000, driver_code: "HUL", player_name: null }], trace });
    const got = await loadSharedGhost(config, track, "world-record", null, { fetchImpl: truthful.fetchImpl });
    expect(got?.info.driverCode).toBe("HUL");
    expect(got?.samples.length).toBe(601);
    // The row claims 45 s but the trace spans 60 s.
    const lie = fetchWith({ info: [{ lap_id: LAP, lap_ms: 45000, driver_code: "HUL", player_name: null }], trace });
    expect(await loadSharedGhost(config, track, "world-record", null, { fetchImpl: lie.fetchImpl })).toBeNull();
    const none = fetchWith({ info: [] });
    expect(await loadSharedGhost(config, track, "world-record", null, { fetchImpl: none.fetchImpl })).toBeNull();
  });
});
