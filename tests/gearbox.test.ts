import { describe, expect, it } from "vitest";
import {
  GEAR_COUNT,
  GEAR_RATIOS,
  IDLE_RPM,
  REDLINE_RPM,
  REV_LIMITER_RPM,
  SHIFT_DOWN_RPM,
  SHIFT_UP_RPM,
  createGearboxState,
  engineTorqueMultiplier,
  gearThrustFactor,
  rpmForGear,
  updateGearbox,
} from "../lib/physics/gearbox";
import {
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import { simulateDrive } from "../lib/ai/harness";

describe("rpmForGear", () => {
  it("idles at a standstill in any gear", () => {
    expect(rpmForGear(0, 1)).toBe(IDLE_RPM);
    expect(rpmForGear(0, GEAR_COUNT)).toBe(IDLE_RPM);
  });

  it("rises with speed and falls as gears get taller", () => {
    const g1 = rpmForGear(20, 1);
    const g2 = rpmForGear(20, 2);
    const g7 = rpmForGear(20, 7);
    expect(g1).toBeGreaterThan(g2);
    expect(g2).toBeGreaterThan(g7);
    expect(rpmForGear(40, 3)).toBeCloseTo(rpmForGear(20, 3) * 2, 0);
  });

  it("is symmetric for reversing (negative) speed", () => {
    expect(rpmForGear(-25, 4)).toBe(rpmForGear(25, 4));
  });

  it("redlines around 21 m/s in 1st and leaves real top-gear headroom", () => {
    expect(rpmForGear(21, 1)).toBeGreaterThan(SHIFT_UP_RPM);
    expect(rpmForGear(21, 1)).toBeLessThanOrEqual(REDLINE_RPM);
    // The final ratio is deliberately tall: deployment needs somewhere to
    // go after the old 62 m/s artificial ceiling.
    expect(rpmForGear(76, 7)).toBeGreaterThan(SHIFT_UP_RPM);
    expect(rpmForGear(76, 7)).toBeLessThanOrEqual(REDLINE_RPM);
    expect(rpmForGear(85, 7)).toBeGreaterThan(REDLINE_RPM);
  });

  it("returns idle rpm for out-of-range gears", () => {
    expect(rpmForGear(0, 0)).toBe(IDLE_RPM);
    expect(rpmForGear(0, 99)).toBe(IDLE_RPM);
  });
});

describe("engineTorqueMultiplier", () => {
  it("peaks at 1.0 across the whole working band", () => {
    expect(engineTorqueMultiplier(7000)).toBe(1);
    expect(engineTorqueMultiplier(9000)).toBe(1);
    expect(engineTorqueMultiplier(11000)).toBe(1);
  });

  it("is close to peak at idle and at redline", () => {
    expect(engineTorqueMultiplier(IDLE_RPM)).toBeGreaterThan(0.9);
    expect(engineTorqueMultiplier(IDLE_RPM)).toBeLessThan(1);
    expect(engineTorqueMultiplier(REDLINE_RPM)).toBeGreaterThan(0.9);
    expect(engineTorqueMultiplier(REDLINE_RPM)).toBeLessThan(1);
  });

  it("collapses at and past the rev limiter - the missed-shift penalty", () => {
    expect(engineTorqueMultiplier(REV_LIMITER_RPM)).toBeLessThan(0.45);
    expect(engineTorqueMultiplier(14000)).toBeLessThan(0.4);
  });

  it("clamps at both ends of the curve", () => {
    expect(engineTorqueMultiplier(0)).toBe(0.5);
    expect(engineTorqueMultiplier(20000)).toBeLessThan(0.4);
  });
});

describe("gearThrustFactor", () => {
  it("is 1.0 in 1st (legacy launch force preserved) and tapers monotonically", () => {
    expect(gearThrustFactor(1)).toBe(1);
    for (let g = 2; g <= GEAR_COUNT; g++) {
      expect(gearThrustFactor(g)).toBeLessThan(gearThrustFactor(g - 1));
    }
  });

  it("clamps out-of-range gears", () => {
    expect(gearThrustFactor(0)).toBe(gearThrustFactor(1));
    expect(gearThrustFactor(99)).toBe(gearThrustFactor(GEAR_COUNT));
  });
});

describe("updateGearbox (auto-assist)", () => {
  it("upshifts just before redline and the new gear lands in the torque band", () => {
    const gb = createGearboxState(true);
    updateGearbox(gb, { speedMs: 21, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(2);
    // Same speed, one gear up: comfortably inside the band, no churn.
    expect(rpmForGear(21, gb.gear)).toBeGreaterThan(SHIFT_DOWN_RPM);
    expect(rpmForGear(21, gb.gear)).toBeLessThan(SHIFT_UP_RPM);
  });

  it("downshifts once rpm lugs below the floor", () => {
    const gb = createGearboxState(true);
    gb.gear = 6;
    updateGearbox(gb, { speedMs: 20, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(5);
  });

  it("one shift per tick - no oscillation at the boundaries", () => {
    // At the exact upshift boundary, one tick performs exactly one shift.
    const gb = createGearboxState(true);
    const boundary = SHIFT_UP_RPM / (rpmForGear(10, 1) / 10); // speed where 1st crosses SHIFT_UP_RPM
    updateGearbox(gb, { speedMs: boundary + 0.01, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(2);
    updateGearbox(gb, { speedMs: boundary + 0.01, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(2); // no second shift
  });

  it("never leaves [1, GEAR_COUNT]", () => {
    const gb = createGearboxState(true);
    // 1st at 2 m/s: rpm 3000 (idle floor) < SHIFT_DOWN → tries to downshift, stays.
    updateGearbox(gb, { speedMs: 2, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(1);
    gb.gear = GEAR_COUNT;
    // Top gear screaming past the limiter: tries to upshift, stays.
    updateGearbox(gb, { speedMs: 200, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(GEAR_COUNT);
  });

  it("ignores manual shift requests while auto is on", () => {
    const gb = createGearboxState(true);
    // 10 m/s in 1st = 5700 rpm: no auto action, so any gear change would
    // have to come from the (ignored) manual requests.
    updateGearbox(gb, { speedMs: 10, shiftUp: true, shiftDown: true });
    expect(gb.gear).toBe(1);
  });
});

describe("updateGearbox (manual)", () => {
  it("applies edge-triggered up and down requests", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, { speedMs: 5, shiftUp: true, shiftDown: false });
    expect(gb.gear).toBe(2);
    updateGearbox(gb, { speedMs: 5, shiftDown: true, shiftUp: false });
    expect(gb.gear).toBe(1);
  });

  it("does nothing without a request, even off the rev limiter", () => {
    const gb = createGearboxState(false);
    gb.gear = 3;
    // Screaming past the limiter in 3rd - manual mode holds the gear.
    updateGearbox(gb, { speedMs: 60, shiftUp: false, shiftDown: false });
    expect(gb.gear).toBe(3);
  });

  it("clamps at both ends", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, { speedMs: 5, shiftDown: true, shiftUp: false });
    expect(gb.gear).toBe(1);
    gb.gear = GEAR_COUNT;
    updateGearbox(gb, { speedMs: 5, shiftUp: true, shiftDown: false });
    expect(gb.gear).toBe(GEAR_COUNT);
  });

  it("a missed downshift into too-short a gear sits on the rev limiter", () => {
    // 60 m/s in 2nd: firmly past the limiter, ~35% thrust - the real-world
    // "missed shift" penalty that manual gears are supposed to cost.
    expect(rpmForGear(60, 2)).toBeGreaterThan(REV_LIMITER_RPM);
    expect(engineTorqueMultiplier(rpmForGear(60, 2))).toBeLessThan(0.4);
  });

  it("an early shift drops the engine out of the torque peak band", () => {
    // Shifting 1→2 while the engine is still low in rpm (say, 6000) yields
    // ~5000 rpm in 2nd - below the 7000-rpm peak band start, so the next
    // gear pulls less until it climbs back in. Waiting for the band
    // (SHIFT_UP_RPM) instead keeps the next gear right at the peak.
    const ratioToNext = GEAR_RATIOS[1] / GEAR_RATIOS[0];
    const earlyShiftLanding = 6000 * ratioToNext;
    const optimalShiftLanding = SHIFT_UP_RPM * ratioToNext;
    expect(earlyShiftLanding).toBeLessThan(7000);
    expect(engineTorqueMultiplier(earlyShiftLanding)).toBeLessThan(1);
    expect(engineTorqueMultiplier(optimalShiftLanding)).toBe(1);
  });
});

describe("gearbox through simulateDrive (auto)", () => {
  it("climbs through every gear and reaches a healthy straight-line top speed", async () => {
    let maxGear = 1;
    let maxSpeed = 0;
    const result = await simulateDrive(
      10,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        onTelemetry: (sample) => {
          maxGear = Math.max(maxGear, sample.gear);
          maxSpeed = Math.max(maxSpeed, sample.speedMs);
        },
      }
    );
    expect(result.maxTiltRad).toBeLessThan(0.6);
    expect(maxGear).toBe(GEAR_COUNT);
    // The new final gear/drag balance should put the car into the low-80 m/s
    // range on a long flat run, not leave the old 40+ m/s smoke-test floor.
    expect(maxSpeed).toBeGreaterThan(70);
    expect(result.finalSpeedMs).toBeGreaterThan(70);
  });

  it("gives deployment a measurable straight-line advantage", async () => {
    const normal = await simulateDrive(
      12,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      }
    );
    const deployed = await simulateDrive(
      12,
      { throttle: 1, brake: 0, steer: 0, boostMultiplier: 1.6 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      }
    );
    expect(deployed.distanceMeters).toBeGreaterThan(normal.distanceMeters * 1.05);
    expect(deployed.finalSpeedMs).toBeGreaterThan(normal.finalSpeedMs);
  });

  it("stays within 15% of the legacy flat-force straight-line performance", async () => {
    const geared = await simulateDrive(
      15,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      }
    );
    const legacy = await simulateDrive(
      15,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        autoGear: false,
      }
    );
    // The gearbox trades a little peak thrust for the manual-shift skill
    // mechanic, but must never gut the tuned straight-line capability - the
    // distance guard (integrates the full launch+acceleration) holds the
    // A/B within 15% of the legacy flat-force car.
    expect(geared.distanceMeters).toBeGreaterThan(legacy.distanceMeters * 0.85);
    // Top-SPEED is deliberately NOT compared 1:1 against the flat-plane
    // legacy run: without a gearbox the flat force keeps shoving the car
    // past drag equilibrium on the smooth test plane (79 m/s), while the
    // geared car is (correctly) capped by its top-gear rpm band at ~63 m/s
    // - which is the same top end the legacy car actually reached on the
    // real track trimesh (62.4 m/s, per the vehicle.ts comments). The
    // geared car must still hit that real-world top end.
    expect(geared.finalSpeedMs).toBeGreaterThan(60);
  });
});