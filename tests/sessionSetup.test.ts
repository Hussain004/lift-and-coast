import { describe, expect, it } from "vitest";
import {
  buildRaceUrl,
  retargetSessionUrl,
  DEFAULT_RACE_LAPS,
  DEFAULT_RIVALS,
  DEFAULT_TIME_OF_DAY,
  MAX_RACE_LAPS,
  MAX_RIVALS,
  MIN_RACE_LAPS,
  MIN_RIVALS,
  loadSessionSetupPrefs,
  parseDifficulty,
  parseGridSpot,
  parseQualifyingFormat,
  parseRaceLaps,
  parseRivals,
  parseSeed,
  parseSessionMode,
  parseTimeOfDay,
  saveSessionSetupPrefs,
} from "../lib/race/sessionSetup";
import { DEFAULT_TRACK_ID } from "../lib/tracks/registry";
import { DEFAULT_DIFFICULTY } from "../lib/ai/personalities";

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
      weather: "clear",
      rivals: DEFAULT_RIVALS,
      difficulty: DEFAULT_DIFFICULTY,
    });
  });

  it("defaults when nothing was saved", () => {
    expect(loadSessionSetupPrefs(fakeStorage().storage)).toEqual({
      raceLaps: DEFAULT_RACE_LAPS,
      trackId: DEFAULT_TRACK_ID,
      timeOfDay: DEFAULT_TIME_OF_DAY,
      weather: "clear",
      rivals: DEFAULT_RIVALS,
      difficulty: DEFAULT_DIFFICULTY,
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
      weather: "clear",
      rivals: DEFAULT_RIVALS,
      difficulty: DEFAULT_DIFFICULTY,
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
      weather: "clear",
      rivals: DEFAULT_RIVALS,
      difficulty: DEFAULT_DIFFICULTY,
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
        trackId: "atlantis",
      }),
    });
    expect(loadSessionSetupPrefs(storage).trackId).toBe(DEFAULT_TRACK_ID);
  });
});

describe("saveSessionSetupPrefs", () => {
  it("persists the clamped values", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 9, trackId: "monza", timeOfDay: "overcast", weather: "rain", rivals: 5, difficulty: "ace" }, storage);
    expect(loadSessionSetupPrefs(storage)).toEqual({
      raceLaps: 9,
      trackId: "monza",
      timeOfDay: "overcast",
      weather: "rain",
      rivals: 5,
      difficulty: "ace",
    });
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: 9, trackId: "monza", timeOfDay: "overcast", weather: "rain", rivals: 5, difficulty: "ace" })
    );
  });

  it("clamps and rounds before saving", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs({ raceLaps: 4.6, trackId: "suzuka", timeOfDay: "day", weather: "clear", rivals: 1, difficulty: "pro" }, storage);
    expect(loadSessionSetupPrefs(storage).raceLaps).toBe(5);
    saveSessionSetupPrefs({ raceLaps: 0, trackId: "suzuka", timeOfDay: "day", weather: "clear", rivals: 99, difficulty: "club" }, storage);
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: MIN_RACE_LAPS, trackId: "suzuka", timeOfDay: "day", weather: "clear", rivals: MAX_RIVALS, difficulty: "club" })
    );
  });

  it("clamps an unknown track id to the default before saving", () => {
    const { storage, dump } = fakeStorage();
    saveSessionSetupPrefs(
      { raceLaps: 3, trackId: "not-a-registered-track", timeOfDay: "day", weather: "clear", rivals: 2, difficulty: "rookie" },
      storage
    );
    expect(dump()["lift-and-coast.session-setup.v1"]).toBe(
      JSON.stringify({ raceLaps: 3, trackId: DEFAULT_TRACK_ID, timeOfDay: "day", weather: "clear", rivals: 2, difficulty: "rookie" })
    );
  });

  it("does nothing when storage is unavailable", () => {
    expect(() =>
      saveSessionSetupPrefs({ raceLaps: 3, trackId: "spa", timeOfDay: "day", weather: "clear", rivals: 1, difficulty: "pro" }, null)
    ).not.toThrow();
  });
});
describe("session mode params", () => {
  it("parses known modes and falls back to race", () => {
    expect(parseSessionMode("practice")).toBe("practice");
    expect(parseSessionMode("qualifying")).toBe("qualifying");
    expect(parseSessionMode("race")).toBe("race");
    expect(parseSessionMode(null)).toBe("race");
    expect(parseSessionMode("")).toBe("race");
    expect(parseSessionMode("PRACTICE")).toBe("race");
  });

  it("parses qualifying formats with a timed default", () => {
    expect(parseQualifyingFormat("oneshot")).toBe("oneshot");
    expect(parseQualifyingFormat("timed")).toBe("timed");
    expect(parseQualifyingFormat(null)).toBe("timed");
    expect(parseQualifyingFormat("sprint")).toBe("timed");
  });

  it("parses grid spots across the full field", () => {
    expect(parseGridSpot("1")).toBe(1);
    expect(parseGridSpot("2")).toBe(2);
    expect(parseGridSpot("20")).toBe(20);
    expect(parseGridSpot(null)).toBeNull();
    expect(parseGridSpot("0")).toBeNull();
    expect(parseGridSpot("21")).toBeNull();
    expect(parseGridSpot("pole")).toBeNull();
  });

  it("parses rival counts with a duel default", () => {
    expect(parseRivals("1")).toBe(1);
    expect(parseRivals("19")).toBe(19);
    expect(parseRivals(null)).toBe(DEFAULT_RIVALS);
    expect(parseRivals("")).toBe(DEFAULT_RIVALS);
    expect(parseRivals("0")).toBe(MIN_RIVALS);
    expect(parseRivals("99")).toBe(MAX_RIVALS);
    expect(parseRivals("many")).toBe(DEFAULT_RIVALS);
  });

  it("builds full session URLs and omits defaults", () => {
    expect(buildRaceUrl({})).toBe("/race");
    const url = buildRaceUrl({
      mode: "qualifying",
      track: "monza",
      team: "gas",
      driver: "YOU",
      tod: "sunset",
      champ: 2,
      grid: 2,
      qformat: "oneshot",
    });
    expect(url).toBe(
      "/race?mode=qualifying&track=monza&team=gas&driver=YOU&tod=sunset&champ=2&grid=2&qformat=oneshot"
    );
  });

  it("carries the rival count on session URLs", () => {
    expect(buildRaceUrl({ rivals: 19 })).toBe("/race?rivals=19");
    expect(buildRaceUrl({ mode: "race", rivals: 1 })).toBe("/race?mode=race&rivals=1");
  });
});

describe("rivals prefs", () => {
  it("defaults rivals for old saves and clamps the range", () => {
    const { storage } = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ raceLaps: 3, trackId: "spa" }),
    });
    expect(loadSessionSetupPrefs(storage).rivals).toBe(DEFAULT_RIVALS);
    const over = fakeStorage({
      "lift-and-coast.session-setup.v1": JSON.stringify({ raceLaps: 3, trackId: "spa", rivals: 99 }),
    });
    expect(loadSessionSetupPrefs(over.storage).rivals).toBe(MAX_RIVALS);
  });
});

describe("parseDifficulty", () => {
  it("accepts the five tiers and falls back to Pro", () => {
    expect(parseDifficulty("rookie")).toBe("rookie");
    expect(parseDifficulty("club")).toBe("club");
    expect(parseDifficulty("hard")).toBe("hard");
    expect(parseDifficulty("ace")).toBe("ace");
    expect(parseDifficulty(null)).toBe("pro");
    expect(parseDifficulty("legend")).toBe("pro");
  });

  it("round-trips through buildRaceUrl", () => {
    expect(buildRaceUrl({ difficulty: "hard" })).toContain("diff=hard");
    expect(buildRaceUrl({ difficulty: "ace" })).toContain("diff=ace");
  });
});

describe("parseSeed", () => {
  it("accepts non-negative ints, rejects everything else", () => {
    expect(parseSeed("42")).toBe(42);
    expect(parseSeed("0")).toBe(0);
    expect(parseSeed(null)).toBeNull();
    expect(parseSeed("pole")).toBeNull();
    expect(parseSeed("-3")).toBeNull();
  });

  it("round-trips through buildRaceUrl", () => {
    expect(buildRaceUrl({ seed: 99 })).toContain("seed=99");
  });
});

describe("grid order urls", () => {
  it("round-trips ?order= through build and retarget", () => {
    const url = buildRaceUrl({ mode: "race", order: ["VER", "NOR"] });
    expect(url).toContain("order=VER%2CNOR");
    const retargeted = retargetSessionUrl("?track=spa&mode=qualifying", "race", 2, ["NOR", "VER"]);
    expect(retargeted).toContain("mode=race");
    expect(retargeted).toContain("grid=2");
    expect(retargeted).toContain("order=NOR%2CVER");
    expect(retargetSessionUrl("?order=VER", "race", null)).not.toContain("order=");
  });
});
