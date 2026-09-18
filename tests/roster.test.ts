import { describe, expect, it } from "vitest";
import {
  DEFAULT_DRIVER_CODE,
  DEFAULT_TEAM_ID,
  TEAMS,
  isKnownDriverCode,
  isKnownTeamId,
  loadRosterPrefs,
  parseDriverCode,
  parseTeamId,
  resolveRosterSelection,
  saveRosterPrefs,
} from "../lib/race/roster";

function fakeStorage() {
  const store = new Map<string, string>();
  return {
    storage: {
      getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    dump: () => Object.fromEntries(store),
  };
}

describe("roster data", () => {
  it("has a default team and driver that resolve", () => {
    expect(isKnownTeamId(DEFAULT_TEAM_ID)).toBe(true);
    expect(isKnownDriverCode(DEFAULT_DRIVER_CODE)).toBe(true);
  });

  it("fields exactly two drivers per team with unique codes and numbers", () => {
    expect(TEAMS.length).toBeGreaterThan(0);
    const codes = new Set<string>();
    const numbers = new Set<number>();
    for (const team of TEAMS) {
      expect(team.drivers.length).toBe(2);
      for (const driver of team.drivers) {
        expect(codes.has(driver.code)).toBe(false);
        expect(numbers.has(driver.number)).toBe(false);
        codes.add(driver.code);
        numbers.add(driver.number);
      }
    }
  });

  it("uses valid hex livery colors", () => {
    for (const team of TEAMS) {
      for (const color of [team.primaryColor, team.secondaryColor]) {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe("parseTeamId / parseDriverCode", () => {
  it("passes known ids through and clamps unknown ones to the default", () => {
    expect(parseTeamId("ferrari")).toBe("ferrari");
    expect(parseTeamId("not-a-team")).toBe(DEFAULT_TEAM_ID);
    expect(parseTeamId(null)).toBe(DEFAULT_TEAM_ID);
    expect(parseDriverCode("PIA")).toBe("PIA");
    expect(parseDriverCode("XXX")).toBe(DEFAULT_DRIVER_CODE);
    expect(parseDriverCode(null)).toBe(DEFAULT_DRIVER_CODE);
  });
});

describe("resolveRosterSelection", () => {
  it("pairs the driver with their teammate-opponent on the same team", () => {
    const { team, driver, teammate } = resolveRosterSelection("red-bull", "VER");
    expect(team.id).toBe("red-bull");
    expect(driver.code).toBe("VER");
    expect(teammate.code).toBe("HAD");
    expect(teammate.code).not.toBe(driver.code);
  });

  it("falls back to the team's first driver for a cross-team code", () => {
    // A stale saved pick from before a team switch must not mix teams -
    // the opponent is defined as the teammate.
    const { team, driver, teammate } = resolveRosterSelection("mercedes", "VER");
    expect(team.id).toBe("mercedes");
    expect(driver.code).toBe("RUS");
    expect(teammate.code).toBe("ANT");
  });

  it("falls back to the default team for an unknown team", () => {
    const { team } = resolveRosterSelection("not-a-team", "VER");
    expect(team.id).toBe(DEFAULT_TEAM_ID);
  });
});

describe("roster prefs", () => {
  it("round-trips the selection through storage", () => {
    const { storage, dump } = fakeStorage();
    saveRosterPrefs({ teamId: "williams", driverCode: "SAI" }, storage);
    expect(loadRosterPrefs(storage)).toEqual({ teamId: "williams", driverCode: "SAI" });
    expect(JSON.parse(dump()["lift-and-coast.roster.v1"])).toEqual({
      teamId: "williams",
      driverCode: "SAI",
    });
  });

  it("clamps stored garbage to a valid same-team pair", () => {
    const { storage } = fakeStorage();
    storage.setItem(
      "lift-and-coast.roster.v1",
      JSON.stringify({ teamId: "nope", driverCode: "XXX" })
    );
    expect(loadRosterPrefs(storage)).toEqual({
      teamId: DEFAULT_TEAM_ID,
      driverCode: DEFAULT_DRIVER_CODE,
    });
  });

  it("repairs a cross-team stored pair to the stored team", () => {
    const { storage } = fakeStorage();
    storage.setItem(
      "lift-and-coast.roster.v1",
      JSON.stringify({ teamId: "audi", driverCode: "VER" })
    );
    expect(loadRosterPrefs(storage)).toEqual({ teamId: "audi", driverCode: "HUL" });
  });

  it("returns defaults when storage is unavailable", () => {
    expect(loadRosterPrefs(null)).toEqual({
      teamId: DEFAULT_TEAM_ID,
      driverCode: DEFAULT_DRIVER_CODE,
    });
    expect(() => saveRosterPrefs({ teamId: "mclaren", driverCode: "PIA" }, null)).not.toThrow();
  });
});
