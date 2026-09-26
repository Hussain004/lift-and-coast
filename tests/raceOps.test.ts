import { describe, expect, it } from "vitest";
import { getTrack } from "../lib/tracks/trackData";
import {
  buildOvertakeZones,
  createOvertakeSystem,
  OVERTAKE_MIN_SPEED_MS,
} from "../lib/physics/overtake";
import { createEnergySystem } from "../lib/physics/energy";
import { createStrategySystem } from "../lib/race/strategy";
import { createRaceControlSystem } from "../lib/race/raceControl";
import { createReplayController } from "../lib/race/replay";
import { createWeatherSystem } from "../lib/physics/weather";
import { TRACKS } from "../lib/tracks/registry";

describe("race operations systems", () => {
  it("weather changes grip and settles when a preset is selected", () => {
    const weather = createWeatherSystem("clear");
    expect(weather.snapshot().gripMultiplier).toBe(1);
    weather.setPreset("rain");
    for (let i = 0; i < 60 * 60; i++) weather.update(1 / 60);
    const state = weather.snapshot();
    expect(state.rainIntensity).toBeGreaterThan(0.8);
    expect(state.gripMultiplier).toBeLessThan(0.8);
    expect(state.visibilityMeters).toBeLessThan(600);
  });

  it("strategy burns fuel, respects pit windows, and fits a fresh set", () => {
    const strategy = createStrategySystem({ compound: "soft", fuelKg: 1 });
    const track = getTrack("silverstone");
    strategy.update({
      dt: 1,
      speedMs: 50,
      throttle: 1,
      brake: 0,
      progressMeters: 300,
      trackLengthMeters: track.lengthMeters,
      lateralMeters: 5,
      trackHalfWidthMeters: 6,
      lap: 1,
      racing: true,
    });
    expect(strategy.snapshot().fuelWarning).toBe(true);
    strategy.requestPit();
    strategy.update({
      dt: 0.1,
      speedMs: 0,
      throttle: 0,
      brake: 1,
      progressMeters: 5,
      trackLengthMeters: track.lengthMeters,
      lateralMeters: 0,
      trackHalfWidthMeters: 6,
      lap: 1,
      racing: true,
    });
    expect(strategy.snapshot().pitPhase).toBe("requested");
    strategy.update({
      dt: 0.1,
      speedMs: 0,
      throttle: 0,
      brake: 1,
      progressMeters: 5,
      trackLengthMeters: track.lengthMeters,
      lateralMeters: 5,
      trackHalfWidthMeters: 6,
      lap: 1,
      racing: true,
    });
    for (let i = 0; i < 40; i++) {
      strategy.update({
        dt: 0.1,
        speedMs: 0,
        throttle: 0,
        brake: 1,
        progressMeters: 5,
        trackLengthMeters: track.lengthMeters,
        lap: 1,
        racing: true,
      });
    }
    expect(strategy.snapshot().pitStops).toBe(1);
    expect(strategy.snapshot().tireAgeMeters).toBe(0);
    expect(strategy.snapshot().fuelKg).toBeGreaterThan(99);
  });

  it("ERS deployment budget resets on a new lap", () => {
    const energy = createEnergySystem(1, "balanced");
    const first = energy.update({ brakeAmount: 0, deployRequested: true, lap: 1, raceStarted: true }, 1);
    expect(first.deploymentBudgetFraction).toBeLessThan(1);
    const nextLap = energy.update({ brakeAmount: 0, deployRequested: false, lap: 2, raceStarted: true }, 1 / 60);
    expect(nextLap.deploymentBudgetFraction).toBe(1);
  });

  it("does not harvest ERS energy before the race starts", () => {
    const energy = createEnergySystem(0, "balanced");
    const status = energy.update({ brakeAmount: 1, deployRequested: false, raceStarted: false }, 1);
    expect(status.batteryFraction).toBe(0);
  });

  it("ERS modes trade deployment strength, drain, and thermal load", () => {
    const balanced = createEnergySystem(1, "balanced");
    const attack = createEnergySystem(1, "attack");
    const balancedStatus = balanced.update({ brakeAmount: 0, deployRequested: true }, 1);
    const attackStatus = attack.update({ brakeAmount: 0, deployRequested: true }, 1);
    expect(attackStatus.engineForceMultiplier).toBeGreaterThan(balancedStatus.engineForceMultiplier);
    expect(attackStatus.batteryFraction).toBeLessThan(balancedStatus.batteryFraction);
    expect(attackStatus.thermalFraction).toBeGreaterThan(balancedStatus.thermalFraction);
  });

  it("derives at least one overtake zone for every registered circuit", () => {
    for (const meta of TRACKS) {
      expect(buildOvertakeZones(getTrack(meta.id)).length, meta.id).toBeGreaterThan(0);
    }
  });

  it("builds usable overtake zones and only opens them at speed", () => {
    const track = getTrack("silverstone");
    const zones = buildOvertakeZones(track);
    expect(zones.length).toBeGreaterThan(0);
    const system = createOvertakeSystem(track);
    const zone = zones[0];
    system.setRequested(true);
    system.update(zone.startMeters + 1, OVERTAKE_MIN_SPEED_MS - 1);
    expect(system.snapshot().active).toBe(false);
    system.update(zone.startMeters + 1, OVERTAKE_MIN_SPEED_MS + 1);
    expect(system.snapshot().active).toBe(true);
  });

  it("gates race overtake by one-second proximity, but not in practice or qualifying", () => {
    const track = getTrack("silverstone");
    const zone = buildOvertakeZones(track)[0];
    const race = createOvertakeSystem(track, "race");
    race.setRequested(true);
    race.update(zone.startMeters + 1, OVERTAKE_MIN_SPEED_MS + 15, OVERTAKE_MIN_SPEED_MS + 15);
    expect(race.snapshot().active).toBe(true);
    race.update(zone.startMeters + 1, OVERTAKE_MIN_SPEED_MS + 15, OVERTAKE_MIN_SPEED_MS + 16);
    expect(race.snapshot().active).toBe(false);

    for (const mode of ["practice", "qualifying"] as const) {
      const openSession = createOvertakeSystem(track, mode);
      openSession.setRequested(true);
      openSession.update(zone.startMeters + 1, OVERTAKE_MIN_SPEED_MS + 15, Infinity);
      expect(openSession.snapshot().active, mode).toBe(true);
    }
  });

  it("race control accumulates steward decisions without an early ban", () => {
    const control = createRaceControlSystem();
    control.reportIncident("track-limits", 10);
    control.reportIncident("unsafe-rejoin", 20);
    control.reportIncident("pit-speeding", 30);
    const state = control.snapshot();
    // 5s + 20s drive-through + 20s drive-through, 2 + 2 + 1 license points.
    expect(state.penaltySeconds).toBe(45);
    expect(state.penaltyPoints).toBe(5);
    expect(state.disqualified).toBe(false);
    expect(state.decisions[1]?.severity).toBe("drive-through");
  });

  it("bans a driver who reaches the FIA 12-point license threshold", () => {
    const control = createRaceControlSystem();
    // Six track-limits penalties at 2 points each reach the 12-point ban.
    for (let i = 0; i < 6; i++) control.reportIncident("track-limits", 10 * (i + 1));
    const state = control.snapshot();
    expect(state.penaltyPoints).toBe(12);
    expect(state.disqualified).toBe(true);
    expect(state.decisions.at(-1)?.message).toContain("RACE BAN");
  });

  it("replay controller records telemetry and scrubs a timeline", () => {
    const replay = createReplayController(2, 1 / 10);
    for (let i = 0; i < 30; i++) {
      replay.record({
        position: { x: i, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        linvel: { x: 1, y: 0, z: 0 },
        angvel: { x: 0, y: 0, z: 0 },
        telemetry: {
          elapsedSeconds: i / 10,
          speedMs: i,
          throttle: 1,
          brake: 0,
          steer: 0,
          gear: 3,
          rpm: 5000,
          batteryFraction: 0.8,
          tireGrip: 0.98,
          overtakeActive: false,
          weather: "clear",
        },
      });
    }
    expect(replay.state().durationSeconds).toBeGreaterThan(1.5);
    expect(replay.telemetryTrace(5).length).toBeLessThanOrEqual(5);
    replay.togglePlayback();
    replay.seekRelative(0.5);
    replay.tick(0.1);
    expect(replay.state().playback).toBe(true);
    expect(replay.frameAtCursor()?.telemetry.speedMs).toBeGreaterThan(0);
  });
});
