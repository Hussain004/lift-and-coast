import { describe, expect, it } from "vitest";
import {
  FUEL_MASS_SIMULATION_KG_PER_KG,
  FUEL_MASS_UPDATE_THRESHOLD_KG,
  fuelAdditionalMassKg,
} from "../lib/physics/fuelMass";
import { createStrategySystem } from "../lib/race/strategy";

describe("fuelAdditionalMassKg", () => {
  it("adds 33 kg at a full 100 kg tank - the 15 % ratio a real car runs", () => {
    expect(fuelAdditionalMassKg(100)).toBeCloseTo(100 * FUEL_MASS_SIMULATION_KG_PER_KG, 8);
    expect(fuelAdditionalMassKg(100)).toBeCloseTo(33, 0);
    expect(FUEL_MASS_SIMULATION_KG_PER_KG).toBeCloseTo(0.33, 8);
  });

  it("scales linearly and vanishes at an empty tank", () => {
    expect(fuelAdditionalMassKg(0)).toBe(0);
    expect(fuelAdditionalMassKg(50)).toBeCloseTo(16.5, 6);
  });

  it("never lets garbage into the physics world", () => {
    expect(fuelAdditionalMassKg(Number.NaN)).toBe(0);
    expect(fuelAdditionalMassKg(Number.POSITIVE_INFINITY)).toBe(0);
    expect(fuelAdditionalMassKg(-40)).toBe(0);
  });

  it("keeps the update quantization far below a lap of fuel burn", () => {
    // A lap of racing burns ~2 kg; the mass quantization has to be finer,
    // or the car sheds mass only once every several laps.
    expect(FUEL_MASS_UPDATE_THRESHOLD_KG).toBeLessThan(1);
  });
});

describe("fuelMassModel strategy option", () => {
  it("leaves the validated full-tank pace shim in place for AI-style callers", () => {
    const brimmed = createStrategySystem({ fuelKg: 100 });
    expect(brimmed.snapshot().paceMultiplier).toBeLessThan(1);
    expect(brimmed.snapshot().paceMultiplier).toBeGreaterThan(0.9);
    const empty = createStrategySystem({ fuelKg: 0 });
    expect(empty.snapshot().paceMultiplier).toBe(1);
  });

  it("drops the shim entirely when fuel is carried as real mass", () => {
    const brimmed = createStrategySystem({ fuelKg: 100, fuelMassModel: true });
    expect(brimmed.snapshot().paceMultiplier).toBeCloseTo(1, 8);
    // And stays dropped through the mass lifecycle: an empty tank in the
    // model carries no shim penalty either (it's simply a light car).
    const empty = createStrategySystem({ fuelKg: 0, fuelMassModel: true });
    expect(empty.snapshot().paceMultiplier).toBeCloseTo(1, 8);
  });

  it("keeps the running-out-of-fuel engine cutout regardless of the model", () => {
    const starved = createStrategySystem({ fuelKg: 0, fuelMassModel: true });
    expect(starved.snapshot().engineMultiplier).toBeLessThan(1);
    const full = createStrategySystem({ fuelKg: 100, fuelMassModel: true });
    expect(full.snapshot().engineMultiplier).toBe(1);
  });
});
