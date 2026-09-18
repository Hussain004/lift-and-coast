import { describe, expect, it } from "vitest";
import {
  DEFAULT_RACE_LAPS,
  DEFAULT_TIME_OF_DAY,
  MAX_RACE_LAPS,
  MIN_RACE_LAPS,
  loadSessionSetupPrefs,
  parseRaceLaps,
  parseTimeOfDay,
  saveSessionSetupPrefs,
} from "../lib/race/sessionSetup";
import { DEFAULT_TRACK_ID } from "../lib/tracks/registry";

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

describe("parseTimeOfDay", () => {
  it("passes the three presets through and defaults everything else", () => {
    expect(parseTimeOfDay("day")).toBe("day");
    expect(parseTimeOfDay("sunset")).toBe("sunset");
    expect(parseTimeOfDay("overcast")).toBe("overcast");
    expect(parseTimeOfDay("night")).toBe(DEFAULT_TIME_OF_DAY);
    expect(parseTimeOfDay(null)).toBe(DEFAULT_TIME_OF_DAY);
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
    expect(loadSessionSetupPrefs(null)).toEqual({
      raceLaps: DEFAULT_RACE_LAPS,
      trackId: DEFAULT_TRACK_ID,
      timeOfDay: DEFAULT_TIME_OF_DAY,
    });
  });

  it("defaults when nothing was saved", () => {
    expect(loadSessionSetupPrefs(fakeStorage().storage)).toEqual({
      raceLaps: DEFAULT_RACE_LAPS,
      trackId: DEFAULT_TRACK_ID,
      timeOfDay: DEFAULT_TIME_OF_DAY,
    });
  });

  it("reads the saved lap count and track", () => {
    const { storage } = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({
        raceLaps: 7,
        trackId: "spa",
      }),
    });
    // Blobs saved before time-of-day existed carry no tod - they load as day.
    expect(loadSessionSetupPrefs(storage)).toEqual({
      raceLaps: 7,
      trackId: "spa",
      timeOfDay: "day",
    });
  });

  it("reads a saved time-of-day and clamps an unknown one", () => {
    const { storage } = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({
        raceLaps: 3,
        trackId: "spa",
        timeOfDay: "sunset",
      }),
    });
    expect(loadSessionSetupPrefs(storage).timeOfDay).toBe("sunset");
    const bad = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({
        raceLaps: 3,
        trackId: "spa",
        timeOfDay: "night",
      }),
    });
    expect(loadSessionSetupPrefs(bad.storage).timeOfDay).toBe(DEFAULT_TIME_OF_DAY);
  });

  it("clamps corrupt or out-of-range saved values", () => {
    const outOfRange = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ raceLaps: 12345 }),
    });
    expect(loadSessionSetupPrefs(outOfRange.storage).raceLaps).toBe(MAX_RACE_LAPS);

    const garbage = fakeStorage({
      "lift-and-coast.session-setup.v1": "not json at all",
    });
    expect(loadSessionSetupPrefs(garbage.storage)).toEqual({
      raceLaps: DEFAULT_RACE_LAPS,
      trackId: DEFAULT_TRACK_ID,
      timeOfDay: DEFAULT_TIME_OF_DAY,
    });

    const wrongShape = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ laps: 9 }),
    });
    expect(loadSessionSetupPrefs(wrongShape.storage).raceLaps).toBe(DEFAULT_RACE_LAPS);
  });

  it("falls back to the default track for an unknown saved id", () => {
    const { storage } = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({
        raceLaps: 5,
        trackId: "nurburgring",
      }),
    });
    expect(loadSessionSetupPrefs(storage).trackId).toBe(DEFAULT_TRACK_ID);
  });
});

describe("saveSessionSetupPrefs", () => {
  it("persists the clamped values", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 9, trackId: "monza", timeOfDay: "overcast" }, storage);
    expect(loadSessionSetupPrefs(storage)).toEqual({
      raceLaps: 9,
      trackId: "monza",
      timeOfDay: "overcast",
    });
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: 9, trackId: "monza", timeOfDay: "overcast" })
    );
  });

  it("clamps and rounds before saving", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 4.6, trackId: "suzuka", timeOfDay: "day" }, storage);
    expect(loadSessionSetupPrefs(storage).raceLaps).toBe(5);
    saveSessionSetupPrefs({ raceLaps: 0, trackId: "suzuka", timeOfDay: "day" }, storage);
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: MIN_RACE_LAPS, trackId: "suzuka", timeOfDay: "day" })
    );
  });

  it("clamps an unknown track id to the default before saving", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs(
      { raceLaps: 3, trackId: "not-a-registered-track", timeOfDay: "day" },
      storage
    );
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: 3, trackId: DEFAULT_TRACK_ID, timeOfDay: "day" })
    );
  });

  it("does nothing when storage is unavailable", () => {
    expect(() =>
      saveSessionSetupPrefs({ raceLaps: 3, trackId: "spa", timeOfDay: "day" }, null)
    ).not.toThrow();
  });
});