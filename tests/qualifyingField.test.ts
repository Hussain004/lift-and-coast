import { describe, expect, it } from "vitest";
import { getTrack } from "../lib/tracks/trackData";
import { createQualifyingReferenceTimes } from "../lib/race/qualifyingField";

const rivals = [
  { code: "VER" },
  { code: "LEC" },
  { code: "NOR" },
];

describe("createQualifyingReferenceTimes", () => {
  it("creates a finite, driver-specific reference lap for every rival", () => {
    const times = createQualifyingReferenceTimes(getTrack("spielberg"), rivals, "pro");
    expect(times.player).toBeNull();
    expect(times.opponents).toHaveLength(rivals.length);
    expect(times.opponents.every((time) => typeof time === "number" && Number.isFinite(time) && time > 0)).toBe(true);
    expect(new Set(times.opponents).size).toBeGreaterThan(1);
    expect(createQualifyingReferenceTimes(getTrack("spielberg"), rivals, "pro")).toEqual(times);
  });

  it("keeps the reference field ordered by difficulty", () => {
    const track = getTrack("spielberg");
    const rookie = createQualifyingReferenceTimes(track, rivals, "rookie");
    const pro = createQualifyingReferenceTimes(track, rivals, "pro");
    const ace = createQualifyingReferenceTimes(track, rivals, "ace");
    const average = (times: number[]) => times.reduce((sum, time) => sum + time, 0) / times.length;
    expect(average(rookie.opponents as number[])).toBeGreaterThan(average(pro.opponents as number[]));
    expect(average(pro.opponents as number[])).toBeGreaterThan(average(ace.opponents as number[]));
  });
});
