import { describe, expect, it } from "vitest";
import { exportSaveData, importSaveData } from "../lib/persistence/personalBests";

// indexedDB is undefined in this project's plain-node test environment (see
// vitest.config.ts) - same convention as the rest of personalBests.ts,
// which has no existing tests for its own IndexedDB-touching internals
// either. What IS testable without a browser: importSaveData's input
// validation (throws before ever touching indexedDB) and exportSaveData's
// documented fallback shape when indexedDB is unavailable.
describe("importSaveData validation", () => {
  it.each([
    ["null", null],
    ["a string", "not an object"],
    ["missing personalBests", {}],
    ["personalBests is null", { personalBests: null }],
    ["personalBests is a string", { personalBests: "nope" }],
  ])("rejects %s", async (_label, bundle) => {
    await expect(importSaveData(bundle)).rejects.toThrow("Not a valid Lift & Coast save file.");
  });

  it("accepts a well-formed empty bundle", async () => {
    await expect(importSaveData({ schemaVersion: 1, personalBests: {} })).resolves.toBeUndefined();
  });

  it("rejects a bundle with a malformed per-track record instead of silently corrupting the store", async () => {
    await expect(
      importSaveData({ personalBests: { silverstone: "garbage" } })
    ).rejects.toThrow('bad record for "silverstone"');
    await expect(
      importSaveData({ personalBests: { silverstone: { bestLapSeconds: 90.5 } } }) // missing ghost
    ).rejects.toThrow('bad record for "silverstone"');
  });

  it("accepts a well-formed record", async () => {
    await expect(
      importSaveData({
        personalBests: { silverstone: { schemaVersion: 1, bestLapSeconds: 90.5, ghost: [] } },
      })
    ).resolves.toBeUndefined();
  });
});

describe("exportSaveData", () => {
  it("returns an empty bundle with the right shape when indexedDB is unavailable", async () => {
    const bundle = await exportSaveData();
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.personalBests).toEqual({});
    expect(() => new Date(bundle.exportedAt).toISOString()).not.toThrow();
  });
});
