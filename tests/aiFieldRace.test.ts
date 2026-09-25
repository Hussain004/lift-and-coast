// The AI field races itself on the real track trimeshes, through the same
// shared racecraft step and vehicle rig the game runs (see
// tests/helpers/fieldSim.ts). These gates pin the two things racing needs
// at once: cars that actually pass each other, and cars that don't crash
// into each other doing it. The contact/spin gates were introduced with the
// lane-aware racecraft (see lib/ai/racecraft.ts); the previous generation
// measured 48-132 contacts and 3-5 spins per car-field on these same runs.
import { describe, expect, it } from "vitest";
import { simulateField, type FieldResult } from "./helpers/fieldSim";
import { traitsForDriver } from "../lib/ai/personalities";
import { getTrack } from "../lib/tracks/trackData";
import suzuka from "../data/tracks/suzuka.json";
import type { TrackData } from "../lib/tracks/types";

const FLIP_THRESHOLD_RAD = 0.6;
const FIELD = ["COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM", "LEC", "NOR"];

function upright(result: FieldResult): void {
  for (const car of result.cars) expect(car.maxTilt).toBeLessThan(FLIP_THRESHOLD_RAD);
  expect(result.field.firewallResets).toBe(0);
}

describe("AI field race", () => {
  it("the fastest driver, starting last, takes the lead on most circuits", async () => {
    // Slowest trait on pole, fastest last, 120s: passing is mandatory.
    // Between near-identical cars this needs the whole toolkit - the tow,
    // Manual Override Mode, out-braking - and it must be clean.
    const codes = ["VER", "NOR", "LEC", "PIA", "RUS", "HAM", "ALO", "GAS", "SAI", "STR"];
    const byPace = [...codes].sort((a, b) => traitsForDriver(a).pace - traitsForDriver(b).pace);
    const order = [byPace[0], byPace[5], byPace[byPace.length - 1]];
    let tookLead = 0;
    for (const trackId of ["silverstone", "monza", "spa", "bahrain", "suzuka"]) {
      const result = await simulateField(order, {
        seconds: 120,
        track: getTrack(trackId),
        // Club is the conservative racecraft baseline; the Pro/Ace field
        // itself is covered by the all-track standing-start diagnostics.
        difficulty: "club",
      });
      upright(result);
      expect(result.field.contacts).toBeLessThanOrEqual(2);
      expect(result.field.spins).toBe(0);
      if (result.field.leadChanges >= 1) tookLead++;
    }
    // Observed 4 of 5 when the gate was set.
    expect(tookLead).toBeGreaterThanOrEqual(3);
  }, 300000);

  // Ten cars, 150s (a lap and a bit), grid order with the quick drivers at
  // the back. "passes" counts completed overtakes (a pair's order flips
  // and holds 3s). Observed when set: 2/3/10/8 passes, 0-7 contacts (mostly
  // lap-one hairpin bumps under 5 m/s), 0 spins, 0 recoveries. The previous
  // generation measured 48-132 contacts and 3-5 spins on these same runs.
  it("a ten-car field races clean and keeps passing", async () => {
    let passes = 0;
    for (const trackId of ["silverstone", "monza", "spa", "bahrain"]) {
      const result = await simulateField(FIELD, {
        seconds: 150,
        track: getTrack(trackId),
        // Keep this racecraft regression independent of the deliberately
        // faster Pro/Ace pace tiers; their field gates run separately.
        difficulty: "club",
      });
      upright(result);
      const { field } = result;
      expect(field.passes, trackId).toBeGreaterThanOrEqual(1);
      expect(field.contacts, trackId).toBeLessThanOrEqual(12);
      expect(field.hardContacts, trackId).toBeLessThanOrEqual(4);
      expect(field.spins, trackId).toBeLessThanOrEqual(1);
      expect(field.recoveries, trackId).toBe(0);
      // Nobody wrecked or beached: the old generation left cars parked at
      // 1,174m after a 33 m/s shunt on the Spa run.
      for (const car of result.cars) expect(car.traveled, trackId).toBeGreaterThan(3800);
      passes += field.passes;
    }
    expect(passes).toBeGreaterThanOrEqual(12);
  }, 480000);

  it("places and launches a full Hungaroring grid on its curved run to turn one", async () => {
    const codes = [
      "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM", "LEC", "OCO",
      "BEA", "NOR", "PIA", "RUS", "ANT", "LAW", "LIN", "VER", "HAD", "SAI",
    ];
    const result = await simulateField(codes, {
      seconds: 12,
      holdSeconds: 3,
      track: getTrack("budapest"),
    });
    upright(result);
    expect(result.field.recoveries).toBe(0);
    expect(result.field.contacts).toBeLessThanOrEqual(20);
    for (const car of result.cars) {
      expect(car.traveled).toBeGreaterThan(20);
      expect(car.maxOffTrack).toBeLessThan(6);
    }
  }, 120000);

  it("an Ace field is measurably faster than a Pro field and stays upright", async () => {
    const codes = ["VER", "HAM", "ALO", "HUL", "STR", "COL"];
    const pro = await simulateField(codes, { seconds: 120 });
    const ace = await simulateField(codes, { seconds: 120, difficulty: "ace" });
    upright(pro);
    upright(ace);
    for (const car of [...pro.cars, ...ace.cars]) expect(car.traveled).toBeGreaterThan(1500);
    const mean = (r: FieldResult): number => r.cars.reduce((sum, car) => sum + car.traveled, 0) / r.cars.length;
    expect(mean(ace)).toBeGreaterThan(mean(pro) * 1.05);
    // Batteries must actually cycle.
    expect(Math.min(...ace.cars.map((car) => car.finalBattery))).toBeLessThan(0.9);
  }, 240000);

  it("the field streams past a car stalled on pole without touching it", async () => {
    // The player sitting on pole at the lights: the old field (whose
    // pace floor couldn't brake for a stopped car) punted it off the road.
    const codes = ["GAS", "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT"];
    const result = await simulateField(codes, { seconds: 40, holdSeconds: 3, parked: ["GAS"] });
    upright(result);
    expect(result.field.parkedContacts).toBe(0);
    expect(result.field.recoveries).toBe(0);
    for (const car of result.cars.filter((c) => c.code !== "GAS")) {
      expect(car.traveled).toBeGreaterThan(900);
    }
  }, 180000);

  it("the field picks through a car parked on the line mid-grid", async () => {
    const codes = ["COL", "ALO", "STR", "GAS", "HUL", "BOR", "PER", "BOT", "HAM"];
    const result = await simulateField(codes, { seconds: 75, holdSeconds: 3, parked: ["GAS"] });
    upright(result);
    expect(result.field.parkedContacts).toBeLessThanOrEqual(1);
    for (const car of result.cars.filter((c) => c.code !== "GAS")) {
      expect(car.traveled).toBeGreaterThan(1500);
    }
  }, 180000);

  it("a full 20-car grid survives the Suzuka start without solver death", async () => {
    const codes = [
      "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM",
      "LEC", "OCO", "BEA", "NOR", "PIA", "RUS", "ANT", "LAW",
      "LIN", "VER", "HAD", "SAI",
    ];
    const result = await simulateField(codes, { seconds: 30, holdSeconds: 3, track: suzuka as TrackData });
    upright(result);
    for (const car of result.cars) expect(car.traveled).toBeGreaterThan(500);
    expect(result.field.hardContacts).toBeLessThanOrEqual(3);
  }, 240000);
});

describe("crossover decks", () => {
  it("holds progress continuity over and under Suzuka's bridge", async () => {
    // Two cars circulating 150s cross both decks several times each: a 2D
    // nearest-point lookup would snap cars between decks.
    const result = await simulateField(["VER", "HAM"], { seconds: 150, holdSeconds: 3, track: suzuka as TrackData });
    upright(result);
    for (const car of result.cars) expect(car.traveled).toBeGreaterThan(4000);
  }, 240000);
});
