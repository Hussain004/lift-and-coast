import { describe, expect, it } from "vitest";
import {
  DEFAULT_RACE_LAPS,
  MAX_RACE_LAPS,
  MIN_RACE_LAPS,
  loadSessionSetupPrefs,
  parseRaceLaps,
  saveSessionSetupPrefs,
} from "../lib/race/sessionSetup";

describe("parseRaceLaps", () => {
  it("returns the default for no param", () => {
    expect(parseRaceLaps(null)).toBe(DEFAULT_RACE_LAPS);
  });

  it("parses a valid lap count", () => {
    expect(parseRaceLaps("3")).toBe(3);
    expect(parseRaceLaps("1")).toBe(1);
    expect(parseRaceLaps("20")).toBe(20);
  });

  it("clamps out-of-range values instead of trusting the URL", () => {
    expect(parseRaceLaps("0")).toBe(MIN_RACE_LAPS);
    expect(parseRaceLaps("-5")).toBe(MIN_RACE_LAPS);
    expect(parseRaceLaps("999")).toBe(MAX_RACE_LAPS);
  });

  it("falls back for garbage", () => {
    expect(parseRaceLaps("abc")).toBe(DEFAULT_RACE_LAPS);
    expect(parseRaceLaps("")).toBe(DEFAULT_RACE_LAPS);
    expect(parseRaceLaps("2.5")).toBe(2); // parseInt truncates, then clamps
  });
});

function fakeStorage(initial: Record<string, string> = {}): {
  storage: Pick<Storage, "getItem" | "setItem">;
  dump: () => Record<string, string>;
} {
  const map = new Map(Object.entries(initial));
  return {
    storage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    },
    dump: () => Object.fromEntries(map),
  };
}

describe("loadSessionSetupPrefs", () => {
  it("defaults when no storage exists", () => {
    expect(loadSessionSetupPrefs(null)).toEqual({ raceLaps: DEFAULT_RACE_LAPS });
  });

  it("defaults when nothing was saved", () => {
    expect(loadSessionSetupPrefs(fakeStorage().storage)).toEqual({
      raceLaps: DEFAULT_RACE_LAPS,
    });
  });

  it("reads the saved lap count", () => {
    const { storage } = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ raceLaps: 7 }),
    });
    expect(loadSessionSetupPrefs(storage)).toEqual({ raceLaps: 7 });
  });

  it("clamps corrupt or out-of-range saved values", () => {
    const outOfRange = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ raceLaps: 12345 }),
    });
    expect(loadSessionSetupPrefs(outOfRange.storage).raceLaps).toBe(MAX_RACE_LAPS);

    const garbage = fakeStorage({
      "lift-and-coast.session-setup.v1": "not json at all",
    });
    expect(loadSessionSetupPrefs(garbage.storage).raceLaps).toBe(DEFAULT_RACE_LAPS);

    const wrongShape = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ laps: 9 }),
    });
    expect(loadSessionSetupPrefs(wrongShape.storage).raceLaps).toBe(DEFAULT_RACE_LAPS);
  });
});

describe("saveSessionSetupPrefs", () => {
  it("persists the clamped value", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 9 }, storage);
    expect(loadSessionSetupPrefs(storage)).toEqual({ raceLaps: 9 });
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(JSON.stringify({ raceLaps: 9 }));
  });

  it("clamps and rounds before saving", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 4.6 }, storage);
    expect(loadSessionSetupPrefs(storage).raceLaps).toBe(5);
    saveSessionSetupPrefs({ raceLaps: 0 }, storage);
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(JSON.stringify({ raceLaps: MIN_RACE_LAPS }));
  });

  it("does nothing when storage is unavailable", () => {
    expect(() => saveSessionSetupPrefs({ raceLaps: 3 }, null)).not.toThrow();
  });
});