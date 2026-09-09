import { describe, expect, it } from "vitest";
import { createEnergySystem } from "../lib/physics/energy";

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
