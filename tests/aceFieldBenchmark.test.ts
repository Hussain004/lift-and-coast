// Run the complete all-track field/grid sweep with
// `npm run diagnose:ace-field`. It is opt-in so the normal unit suite does not
// create 27 Rapier worlds on every run, while the command remains a
// repeatable stability gate.
//
// This is intentionally a racecraft/launch stability gate, not a full
// production vehicle calibration: it shares the vehicle rig and
// `stepRacecraft` with AICar, while live AICar additionally owns strategy,
// ERS, weather, and overtake-system state. The standing-start sweep owns the
// Pro/Ace line and pace calibration.
import { describe, expect, it } from "vitest";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { simulateField } from "./helpers/fieldSim";

const runFieldBenchmark = process.env.ACE_FIELD_BENCHMARK === "1" ? it : it.skip;
const MAX_OFF_TRACK_METERS = 6;
const FLIP_THRESHOLD_RAD = 0.6;
const ACE_GRID_CODES = [
  "COL", "ALO", "STR", "HUL", "BOR", "PER", "BOT", "HAM", "LEC", "OCO",
  "BEA", "NOR", "PIA", "RUS", "ANT", "LAW", "LIN", "VER", "HAD", "SAI",
];
const ACE_GRID_TRACKS = ["spa", "suzuka", "monaco", "madrid"] as const;
const DIFFICULTIES = ["pro", "ace"] as const;

describe("all-track Ace field stability benchmark", () => {
  // This is a traffic/launch stability sample; the opt-in standing-start
  // benchmark owns the full-lap distance and line-limit assertions.
  for (const difficulty of DIFFICULTIES) {
    for (const meta of TRACKS) {
      runFieldBenchmark(
        `two-car ${difficulty} field stays clean at ${meta.name} (${meta.id})`,
        async () => {
          const result = await simulateField(["VER", "HAM"], {
            seconds: 90,
            holdSeconds: 3,
            difficulty,
            track: getTrack(meta.id),
          });
          console.log(
            `[${difficulty}-field] ${meta.id.padEnd(12)} ` +
              `travel=${result.cars.map((car) => car.traveled.toFixed(0)).join("/")} ` +
              `off=${result.cars.map((car) => car.maxOffTrack.toFixed(1)).join("/")} ` +
              `tilt=${result.cars.map((car) => car.maxTilt.toFixed(2)).join("/")} ` +
              `contacts=${result.field.contacts} spins=${result.field.spins} recoveries=${result.field.recoveries}`
          );
          expect(result.field.firewallResets, `${difficulty}/${meta.id}`).toBe(0);
          expect(result.field.contacts, `${difficulty}/${meta.id}`).toBeLessThanOrEqual(2);
          expect(result.field.hardContacts, `${difficulty}/${meta.id}`).toBeLessThanOrEqual(1);
          expect(result.field.spins, `${difficulty}/${meta.id}`).toBe(0);
          expect(result.field.recoveries, `${difficulty}/${meta.id}`).toBe(0);
          for (const car of result.cars) {
            expect(car.maxTilt, `${difficulty}/${meta.id} ${car.code}`).toBeLessThan(FLIP_THRESHOLD_RAD);
            expect(car.maxOffTrack, `${difficulty}/${meta.id} ${car.code}`).toBeLessThan(MAX_OFF_TRACK_METERS);
            expect(car.traveled, `${difficulty}/${meta.id} ${car.code}`).toBeGreaterThan(900);
          }
        },
        300000
      );
    }
  }

  for (const difficulty of DIFFICULTIES) {
    for (const id of ACE_GRID_TRACKS) {
      runFieldBenchmark(
        `full 20-car ${difficulty} grid launches and survives at ${id}`,
        async () => {
          const result = await simulateField(ACE_GRID_CODES, {
            seconds: 30,
            holdSeconds: 3,
            difficulty,
            track: getTrack(id),
          });
          console.log(
            `[${difficulty}-grid] ${id.padEnd(8)} contacts=${result.field.contacts} hard=${result.field.hardContacts} ` +
              `spins=${result.field.spins} recoveries=${result.field.recoveries} ` +
              `off=${result.cars.map((car) => car.maxOffTrack.toFixed(1)).join("/")}`
          );
          expect(result.field.firewallResets, `${difficulty}/${id}`).toBe(0);
          // A standing 20-car start naturally produces more contact events than
          // the two-car gate; these ceilings catch a grid-wide pile-up while
          // leaving the existing racecraft contact model in charge of the
          // actual side-by-side exchange.
          expect(result.field.contacts, `${difficulty}/${id}`).toBeLessThanOrEqual(16);
          expect(result.field.hardContacts, `${difficulty}/${id}`).toBeLessThanOrEqual(8);
          expect(result.field.spins, `${difficulty}/${id}`).toBe(0);
          expect(result.field.recoveries, `${difficulty}/${id}`).toBe(0);
          for (const car of result.cars) {
            expect(car.maxTilt, `${difficulty}/${id} ${car.code}`).toBeLessThan(FLIP_THRESHOLD_RAD);
            expect(car.maxOffTrack, `${difficulty}/${id} ${car.code}`).toBeLessThan(MAX_OFF_TRACK_METERS);
            expect(car.traveled, `${difficulty}/${id} ${car.code}`).toBeGreaterThan(250);
          }
        },
        300000
      );
    }
  }
});
