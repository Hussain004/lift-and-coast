import { describe, expect, it } from "vitest";
import { createFlagState, flagChipText, stepFlags } from "../lib/race/flags";

const L = 5000;
const car = (progressMeters: number, speedMs = 60, lapCount = 1) => ({ lapCount, progressMeters, speedMs });
const rivals = [{ code: "VER" }, { code: "NOR" }];

describe("marshalling flags", () => {
  it("waves yellow only after a car has sat still on your stretch, ahead of you", () => {
    const state = createFlagState(2);
    const player = car(1000);
    const opps = [car(1200, 0), car(3000)];
    let status = stepFlags(state, rivals, player, opps, L, 1, 60);
    expect(status.yellow).toBeNull(); // only stopped a second
    for (let i = 0; i < 3; i++) status = stepFlags(state, rivals, player, opps, L, 1, 60 + i);
    expect(status.yellow).toEqual({ code: "VER", aheadMeters: 200 });
    expect(flagChipText(status)).toContain("VER STOPPED AHEAD");
    // Moving again clears it.
    opps[0] = car(1200, 50);
    expect(stepFlags(state, rivals, player, opps, L, 1, 70).yellow).toBeNull();
  });

  it("does not flag a stopped car behind you or far ahead, nor anyone on the grid", () => {
    const state = createFlagState(2);
    for (let i = 0; i < 6; i++) {
      expect(stepFlags(state, rivals, car(1000), [car(500, 0), car(2000, 0)], L, 1, 60 + i).yellow).toBeNull();
    }
    const grid = createFlagState(1);
    for (let i = 0; i < 6; i++) {
      expect(stepFlags(grid, [{ code: "VER" }], car(1000), [car(1100, 0)], L, 1, 5 + i).yellow).toBeNull();
    }
  });

  it("wraps across the start line", () => {
    const state = createFlagState(1);
    let status = stepFlags(state, [{ code: "VER" }], car(4900), [car(50, 0)], L, 4, 60);
    status = stepFlags(state, [{ code: "VER" }], car(4900), [car(50, 0)], L, 4, 64);
    expect(status.yellow?.aheadMeters).toBe(150);
  });

  it("shows blue for a car a lap ahead closing from behind, not for one on your lap", () => {
    const state = createFlagState(2);
    const lapper = car(900, 75, 3); // 100 m behind, a lap further round
    const sameLap = car(900, 75, 2);
    expect(stepFlags(state, rivals, car(1000, 60, 2), [lapper, car(3000)], L, 0.1, 60).blue).toEqual({ code: "VER", behindMeters: 100 });
    expect(stepFlags(state, rivals, car(1000, 60, 2), [sameLap, car(3000)], L, 0.1, 60).blue).toBeNull();
    expect(flagChipText({ yellow: null, blue: { code: "VER", behindMeters: 100 } })).toBe("BLUE FLAG · LET VER PASS");
  });
});
