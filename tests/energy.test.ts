import { describe, expect, it } from "vitest";
import {
  LIFT_COAST_HARVEST_FRACTION,
  LIFT_COAST_MIN_SPEED_MS,
  createEnergySystem,
} from "../lib/physics/energy";

describe("createEnergySystem", () => {
  it("starts full by default", () => {
    const energy = createEnergySystem();
    const status = energy.update({ brakeAmount: 0, deployRequested: false }, 1 / 60);
    expect(status.batteryFraction).toBeCloseTo(1, 5);
  });

  it("clamps a given initial fraction to [0, 1]", () => {
    const over = createEnergySystem(1.5);
    const under = createEnergySystem(-0.5);
    expect(over.update({ brakeAmount: 0, deployRequested: false }, 0).batteryFraction).toBe(1);
    expect(under.update({ brakeAmount: 0, deployRequested: false }, 0).batteryFraction).toBe(0);
  });

  it("harvests while braking, proportional to brake amount", () => {
    const fullBrake = createEnergySystem(0);
    let fullStatus;
    for (let i = 0; i < 60; i++) {
      fullStatus = fullBrake.update({ brakeAmount: 1, deployRequested: false }, 1 / 60);
    }
    expect(fullStatus!.batteryFraction).toBeGreaterThan(0);

    const halfBrake = createEnergySystem(0);
    let halfStatus;
    for (let i = 0; i < 60; i++) {
      halfStatus = halfBrake.update({ brakeAmount: 0.5, deployRequested: false }, 1 / 60);
    }
    expect(halfStatus!.batteryFraction).toBeLessThan(fullStatus!.batteryFraction);
  });

  it("never harvests above full", () => {
    const energy = createEnergySystem(1);
    let status;
    for (let i = 0; i < 600; i++) {
      status = energy.update({ brakeAmount: 1, deployRequested: false }, 1 / 60);
    }
    expect(status!.batteryFraction).toBeLessThanOrEqual(1);
  });

  it("does not deploy (or boost) when battery is empty", () => {
    const energy = createEnergySystem(0);
    const status = energy.update({ brakeAmount: 0, deployRequested: true }, 1 / 60);
    expect(status.isDeploying).toBe(false);
    expect(status.engineForceMultiplier).toBe(1);
  });

  it("deploys and boosts engine force while battery is available", () => {
    const energy = createEnergySystem(1);
    const status = energy.update({ brakeAmount: 0, deployRequested: true }, 1 / 60);
    expect(status.isDeploying).toBe(true);
    expect(status.engineForceMultiplier).toBeGreaterThan(1);
  });

  it("drains while deploying and eventually runs out", () => {
    const energy = createEnergySystem(1);
    let status;
    for (let i = 0; i < 600; i++) {
      status = energy.update({ brakeAmount: 0, deployRequested: true }, 1 / 60);
    }
    expect(status!.batteryFraction).toBe(0);
    expect(status!.isDeploying).toBe(false);
  });

  it("prioritizes deploy over harvest when both are requested at once", () => {
    const energy = createEnergySystem(1);
    const status = energy.update({ brakeAmount: 1, deployRequested: true }, 1 / 60);
    expect(status.isDeploying).toBe(true);
    expect(status.batteryFraction).toBeLessThan(1);
  });
});

describe("lift-and-coast harvest", () => {
  it("earns a trickle of harvest while coasting with both pedals free", () => {
    const energy = createEnergySystem(0);
    const status = energy.update(
      { brakeAmount: 0, deployRequested: false, liftCoast: { throttle01: 0, speedMs: 30 } },
      1 / 60
    );
    expect(status.harvestRate).toBeCloseTo(0.15 * LIFT_COAST_HARVEST_FRACTION, 6);
    expect(status.batteryFraction).toBeGreaterThan(0);
    expect(status.thermalFraction).toBe(0);
  });

  it("collects materially less than braking does over the same time", () => {
    const lift = createEnergySystem(0);
    let liftStatus;
    for (let i = 0; i < 60; i++) {
      liftStatus = lift.update(
        { brakeAmount: 0, deployRequested: false, liftCoast: { throttle01: 0, speedMs: 30 } },
        1 / 60
      );
    }
    const brake = createEnergySystem(0);
    let brakeStatus;
    for (let i = 0; i < 60; i++) {
      brakeStatus = brake.update({ brakeAmount: 1, deployRequested: false }, 1 / 60);
    }
    expect(liftStatus!.batteryFraction).toBeGreaterThan(0);
    expect(liftStatus!.batteryFraction).toBeLessThan(brakeStatus!.batteryFraction);
  });

  it("does nothing below the minimum coasting speed", () => {
    const energy = createEnergySystem(0);
    const status = energy.update(
      {
        brakeAmount: 0,
        deployRequested: false,
        liftCoast: { throttle01: 0, speedMs: LIFT_COAST_MIN_SPEED_MS * 0.99 },
      },
      1 / 60
    );
    expect(status.harvestRate).toBe(0);
    expect(status.batteryFraction).toBe(0);
  });

  it("does nothing while applying throttle", () => {
    const energy = createEnergySystem(0);
    const status = energy.update(
      { brakeAmount: 0, deployRequested: false, liftCoast: { throttle01: 0.05, speedMs: 30 } },
      1 / 60
    );
    expect(status.harvestRate).toBe(0);
    expect(status.batteryFraction).toBe(0);
  });

  it("a brake application wins the tick over the coast trickle", () => {
    const energy = createEnergySystem(0);
    const status = energy.update(
      { brakeAmount: 1, deployRequested: false, liftCoast: { throttle01: 0, speedMs: 30 } },
      1 / 60
    );
    // Full braking harvests at the mode's base rate, not the lift fraction.
    expect(status.harvestRate).toBeCloseTo(0.15, 6);
  });

  it("deploying still wins over lift-and-coast", () => {
    const energy = createEnergySystem(1);
    const status = energy.update(
      { brakeAmount: 0, deployRequested: true, liftCoast: { throttle01: 0, speedMs: 30 } },
      1 / 60
    );
    expect(status.isDeploying).toBe(true);
    expect(status.harvestRate).toBe(0);
  });

  it("stays silent before the race starts", () => {
    const energy = createEnergySystem(0);
    const status = energy.update(
      {
        brakeAmount: 0,
        deployRequested: false,
        raceStarted: false,
        liftCoast: { throttle01: 0, speedMs: 30 },
      },
      1 / 60
    );
    expect(status.harvestRate).toBe(0);
    expect(status.batteryFraction).toBe(0);
  });

  it("omitting liftCoast preserves the battery-only contract for AI and headless callers", () => {
    const energy = createEnergySystem(0.5);
    const status = energy.update({ brakeAmount: 0, deployRequested: false }, 1 / 60);
    expect(status.harvestRate).toBe(0);
    expect(status.batteryFraction).toBe(0.5);
  });
});
