import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  buildGhostInfoQuery,
  bytesToBase64,
  fetchGhostInfo,
  fetchGhostTrace,
  rowToGhostInfo,
  submitGhost,
} from "../lib/race/sharedGhosts";

const config = { url: "https://x.supabase.co", publishableKey: "pk" };
const LAP = "123e4567-e89b-42d3-a456-426614174000";

function fakeFetch(handler: (url: string, init: RequestInit) => { ok: boolean; body?: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return { ok: r.ok, json: async () => r.body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("shared ghosts", () => {
  it("round-trips bytes through base64, including large blobs, and refuses garbage", () => {
    const bytes = new Uint8Array(70000).map((_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes("not base64 !!")).toBeNull();
  });

  it("asks for the fastest ghost, or the closest faster one than your best", () => {
    expect(buildGhostInfoQuery("monza", "world-record", null)).toContain("order=lap_ms.asc");
    const rival = buildGhostInfoQuery("monza", "rival", 91234.4)!;
    expect(rival).toContain("lap_ms=lt.91234");
    expect(rival).toContain("order=lap_ms.desc");
    expect(buildGhostInfoQuery("monza", "rival", null)).toBeNull();
  });

  it("maps rows and rejects malformed ones", () => {
    expect(rowToGhostInfo({ lap_id: LAP, lap_ms: 90000, driver_code: "HUL", player_name: "ann" })).toEqual({
      lapId: LAP,
      lapMs: 90000,
      driverCode: "HUL",
      playerName: "ann",
    });
    expect(rowToGhostInfo({ lap_id: LAP, lap_ms: "fast", driver_code: "HUL" })).toBeNull();
    expect(rowToGhostInfo(null)).toBeNull();
  });

  it("fetches info and traces, and degrades to null on every failure", async () => {
    const ok = fakeFetch(() => ({ ok: true, body: [{ lap_id: LAP, lap_ms: 90000, driver_code: "HUL", player_name: null }] }));
    expect((await fetchGhostInfo(config, "monza", "world-record", null, { fetchImpl: ok.fetchImpl }))?.lapMs).toBe(90000);
    expect(ok.calls[0].url).toContain("/rest/v1/ghosts?");

    const empty = fakeFetch(() => ({ ok: true, body: [] }));
    expect(await fetchGhostInfo(config, "monza", "world-record", null, { fetchImpl: empty.fetchImpl })).toBeNull();
    const down = fakeFetch(() => ({ ok: false }));
    expect(await fetchGhostInfo(config, "monza", "world-record", null, { fetchImpl: down.fetchImpl })).toBeNull();
    expect(await fetchGhostInfo(null, "monza", "world-record", null)).toBeNull();

    const blob = new Uint8Array([1, 2, 3, 250]);
    const trace = fakeFetch(() => ({ ok: true, body: [{ trace: bytesToBase64(blob) }] }));
    expect(await fetchGhostTrace(config, LAP, { fetchImpl: trace.fetchImpl })).toEqual(blob);
    expect(await fetchGhostTrace(config, "x; drop table", { fetchImpl: trace.fetchImpl })).toBeNull();
  });

  it("uploads the ghost with the lap's identity, and refuses an oversized trace", async () => {
    const f = fakeFetch(() => ({ ok: true }));
    const upload = {
      lapId: LAP,
      trackId: "monza",
      lapMs: 90123.4,
      driverCode: "GAS",
      clientId: LAP,
      bytes: new Uint8Array([9, 9, 9]),
    };
    expect(await submitGhost(config, upload, "jwt", { fetchImpl: f.fetchImpl })).toBe(true);
    const sent = JSON.parse(f.calls[0].init.body as string);
    expect(sent).toMatchObject({ lap_id: LAP, track_id: "monza", lap_ms: 90123, driver_code: "GAS", client_id: LAP });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    const huge = { ...upload, bytes: new Uint8Array(160000) };
    expect(await submitGhost(config, huge, undefined, { fetchImpl: f.fetchImpl })).toBe(false);
    expect(f.calls).toHaveLength(1);
  });
});
