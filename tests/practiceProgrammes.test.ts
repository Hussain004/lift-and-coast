import { describe, expect, it } from "vitest";
import {
  GATE_COUNT,
  buildGates,
  createProgrammeState,
  paceTarget,
  programmeSummary,
  recordProgrammeLap,
  stepGates,
} from "../lib/race/practiceProgrammes";
import type { RacingLinePoint } from "../lib/tracks/racingLine";

const line = Array.from({ length: 200 }, (_, i) => ({ position: [i * 10, 0, 0] })) as unknown as RacingLinePoint[];

describe("practice programmes", () => {
  it("spreads gates evenly around the line", () => {
    const gates = buildGates(line);
    expect(gates).toHaveLength(GATE_COUNT);
    expect(new Set(gates.map((g) => g.x)).size).toBe(GATE_COUNT);
    expect(gates[0].x).toBeLessThan(gates[1].x);
    expect(buildGates([])).toEqual([]);
  });

  it("completes acclimatisation once every gate has been driven through", () => {
    const gates = buildGates(line);
    const state = createProgrammeState(gates.length, null);
    expect(stepGates(state, gates, 3000, 60)).toBeNull(); // off the line
    gates.slice(0, -1).forEach((g) => expect(stepGates(state, gates, g.x + 2, g.z)).toBeNull());
    const last = gates[gates.length - 1];
    expect(stepGates(state, gates, last.x, last.z + 4)).toBe("acclimatisation");
    expect(stepGates(state, gates, last.x, last.z)).toBeNull(); // only once
  });

  it("needs two consecutive valid laps within tolerance for consistency", () => {
    const state = createProgrammeState(0, null);
    expect(recordProgrammeLap(state, 90, true)).toEqual([]);
    expect(recordProgrammeLap(state, 93, true)).toEqual([]); // 3% apart
    expect(recordProgrammeLap(state, 92.9, false)).toEqual([]); // invalid resets the run
    expect(recordProgrammeLap(state, 93, true)).toEqual([]);
    expect(recordProgrammeLap(state, 93.5, true)).toEqual(["consistency"]);
    expect(recordProgrammeLap(state, 93.5, true)).toEqual([]);
  });

  it("awards pace only for a valid lap under the target", () => {
    const state = createProgrammeState(0, 88);
    expect(recordProgrammeLap(state, 87, false)).toEqual([]);
    expect(recordProgrammeLap(state, 89, true)).toEqual([]);
    expect(recordProgrammeLap(state, 87.5, true)).toEqual(["pace"]);
  });

  it("takes the P15 reference as the pace target", () => {
    const times = Array.from({ length: 19 }, (_, i) => 80 + i);
    expect(paceTarget(times)).toBe(94);
    expect(paceTarget([81, 82])).toBe(82);
    expect(paceTarget([])).toBeNull();
  });

  it("keeps earlier completions and summarises progress", () => {
    const state = createProgrammeState(10, 88.4, { pace: true });
    expect(state.done.pace).toBe(true);
    expect(recordProgrammeLap(state, 80, true)).toEqual([]);
    expect(programmeSummary(state)).toContain("GATES 0/10");
    expect(programmeSummary(state)).toContain("✓ LAP UNDER 1:28.4");
  });
});

import { createSeason, recordPracticeProgramme } from "../lib/race/championship";
import { PROGRAMME_GAIN, REPUTATION_START, seasonObjectives } from "../lib/race/objectives";

describe("practice programme rewards", () => {
  it("records a programme once and ignores bad rounds", () => {
    const season = createSeason(["monza", "spa"], "2026-01-01");
    const once = recordPracticeProgramme(season, 0, "pace");
    expect(once.rounds[0].practice).toEqual({ pace: true });
    expect(recordPracticeProgramme(once, 0, "pace")).toBe(once);
    expect(recordPracticeProgramme(season, 9, "pace")).toBe(season);
    expect(season.rounds[0].practice).toBeUndefined();
  });

  it("pays reputation for each programme, even before the race", () => {
    let season = createSeason(["monza", "spa"], "2026-01-01");
    expect(seasonObjectives(season, null).reputation).toBe(REPUTATION_START);
    season = recordPracticeProgramme(recordPracticeProgramme(season, 0, "pace"), 0, "consistency");
    expect(seasonObjectives(season, null).reputation).toBe(REPUTATION_START + 2 * PROGRAMME_GAIN);
  });
});
