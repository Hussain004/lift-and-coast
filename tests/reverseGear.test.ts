import { describe, expect, it } from "vitest";
import {
  GEAR_COUNT,
  GEAR_RATIOS,
  IDLE_RPM,
  REDLINE_RPM,
  REVERSE_ENGAGE_SPEED_MS,
  REVERSE_GEAR,
  REVERSE_RATIO,
  createGearboxState,
  engineTorqueMultiplier,
  gearThrustFactor,
  isReverse,
  rpmForGear,
  updateGearbox,
} from "../lib/physics/gearbox";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

const track = silverstone as TrackData;

describe("reverse gear selection", () => {
  it("engages reverse from a standstill", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false, selectReverse: true });
    expect(gb.gear).toBe(REVERSE_GEAR);
    expect(isReverse(gb.gear)).toBe(true);
  });

  it("refuses to engage while rolling forward, and does not queue it", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, {
      speedMs: REVERSE_ENGAGE_SPEED_MS + 5,
      shiftUp: false,
      shiftDown: false,
      selectReverse: true,
    });
    expect(gb.gear).not.toBe(REVERSE_GEAR);
    // The request must be gone, not waiting for the car to slow down: dropping
    // into reverse a second later, mid-corner, is a brake failure.
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false });
    expect(gb.gear).not.toBe(REVERSE_GEAR);
  });

  it("engages just inside the speed gate and not just outside it", () => {
    const inside = createGearboxState(false);
    updateGearbox(inside, {
      speedMs: REVERSE_ENGAGE_SPEED_MS,
      shiftUp: false,
      shiftDown: false,
      selectReverse: true,
    });
    expect(inside.gear).toBe(REVERSE_GEAR);

    const outside = createGearboxState(false);
    updateGearbox(outside, {
      speedMs: REVERSE_ENGAGE_SPEED_MS + 0.01,
      shiftUp: false,
      shiftDown: false,
      selectReverse: true,
    });
    expect(outside.gear).not.toBe(REVERSE_GEAR);
  });

  it("is reachable in auto mode too - it is a recovery tool, not a manual-only gear", () => {
    const gb = createGearboxState(true);
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false, selectReverse: true });
    expect(gb.gear).toBe(REVERSE_GEAR);
  });

  it("is NEVER selected by the auto policy or by shift-down", () => {
    // Both shift paths are guarded at gear > 1, so nothing but an explicit
    // reverse request can reach gear 0.
    const auto = createGearboxState(true);
    for (let i = 0; i < 2000; i++) {
      updateGearbox(auto, { speedMs: 0, shiftUp: false, shiftDown: true });
    }
    expect(auto.gear).toBe(1);

    const manual = createGearboxState(false);
    for (let i = 0; i < 2000; i++) {
      updateGearbox(manual, { speedMs: 0, shiftUp: false, shiftDown: true });
    }
    expect(manual.gear).toBe(1);
  });

  it("returns to first gear on a shift-up request, and only from a standstill", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false, selectReverse: true });
    expect(gb.gear).toBe(REVERSE_GEAR);
    updateGearbox(gb, { speedMs: 0, shiftUp: true, shiftDown: false });
    expect(gb.gear).toBe(1);
  });

  it("stays in reverse while reversing, rather than shifting back on its own", () => {
    const gb = createGearboxState(true);
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false, selectReverse: true });
    // Rolling backwards, well under the engage gate, with no input at all.
    for (let i = 0; i < 120; i++) {
      updateGearbox(gb, { speedMs: -1.5, shiftUp: false, shiftDown: false });
    }
    expect(gb.gear).toBe(REVERSE_GEAR);
  });

  it("does not flip back into first while still rolling backwards too fast", () => {
    const gb = createGearboxState(false);
    updateGearbox(gb, { speedMs: 0, shiftUp: false, shiftDown: false, selectReverse: true });
    // Travelling backwards faster than the gate: a shift-up must be refused,
    // or the car would be flipped into a forward gear at speed.
    updateGearbox(gb, { speedMs: -8, shiftUp: true, shiftDown: false });
    expect(gb.gear).toBe(REVERSE_GEAR);
  });
});

describe("reverse ratios and torque", () => {
  it("uses a tall ratio, so reverse revs slowly", () => {
    expect(REVERSE_RATIO).toBeLessThan(GEAR_RATIOS[0]);
    expect(rpmForGear(0, REVERSE_GEAR)).toBe(IDLE_RPM);
    // Tall ratio means it stays on idle for longer than any forward gear
    // would - at 5 m/s reverse is still idling, which is exactly why it can
    // only crawl.
    expect(rpmForGear(5, REVERSE_GEAR)).toBe(IDLE_RPM);
    expect(rpmForGear(20, REVERSE_GEAR)).toBeGreaterThan(IDLE_RPM);
    // ...and the same speed in first gear revs much higher.
    expect(rpmForGear(20, 1)).toBeGreaterThan(rpmForGear(20, REVERSE_GEAR));
  });

  it("is torque limited well below first gear", () => {
    // Reverse has to move the car, not launch it: this is what keeps a
    // reverse mistake from becoming a backwards lap.
    expect(gearThrustFactor(REVERSE_GEAR)).toBeLessThan(gearThrustFactor(1));
    expect(gearThrustFactor(REVERSE_GEAR)).toBeLessThanOrEqual(0.5);
  });

  it("keeps the forward gears untouched", () => {
    for (let gear = 1; gear <= GEAR_COUNT; gear++) {
      expect(isReverse(gear)).toBe(false);
      expect(gearThrustFactor(gear)).toBeCloseTo(1 - (gear - 1) * 0.015, 12);
    }
    expect(REDLINE_RPM).toBeGreaterThan(IDLE_RPM);
    expect(engineTorqueMultiplier(IDLE_RPM)).toBeGreaterThan(0.9);
  });
});

describe("the car actually reverses", () => {
  /** Drives the shared session and returns how far it moved along its own
   *  forward axis - negative means it went backwards. */
  const run = async (useReverse: boolean) => {
    const { createDriveSession } = await import("../lib/ai/driveSession");
    const session = await createDriveSession({ track });
    // Let it settle onto its wheels first.
    for (let i = 0; i < 12; i++) session.advance(1 / 60, { throttle: 0, brake: 0, steer: 0 });
    const start = session.state();
    // Forward is (-sin yaw, -cos yaw); project the displacement onto it.
    const fx = -Math.sin(start.yawRad);
    const fz = -Math.cos(start.yawRad);
    for (let i = 0; i < 3 * 60; i++) {
      // Request reverse on exactly one tick, at a standstill.
      const selectReverse = useReverse && i === 0;
      session.advance(1 / 60, { throttle: 1, brake: 0, steer: 0, selectReverse });
    }
    const end = session.state();
    return {
      alongForward: (end.x - start.x) * fx + (end.z - start.z) * fz,
      speed: end.speedMs,
      gear: end.gear,
    };
  };

  it("moves the car forwards on the forward gears", async () => {
    const forward = await run(false);
    expect(forward.alongForward).toBeGreaterThan(5);
    // Three seconds of full throttle works up the ratios, so the gear is
    // whatever the auto policy reached - but it is a forward gear.
    expect(isReverse(forward.gear)).toBe(false);
    expect(forward.gear).toBeGreaterThanOrEqual(1);
  });

  it("moves the car BACKWARDS in reverse, through the real physics", async () => {
    // The point of the whole feature: the negated engine force in
    // applyCarControls has to actually push the car the other way. Asserted on
    // displacement projected onto the car's own forward axis, so a car that
    // merely spun or drifted cannot pass it.
    const reversed = await run(true);
    expect(reversed.gear).toBe(REVERSE_GEAR);
    expect(reversed.alongForward).toBeLessThan(-1);
    // And the signed speed readout agrees it is travelling backwards.
    expect(reversed.speed).toBeLessThan(0);
  });

  it("reverses far more slowly than it accelerates forwards", async () => {
    // The tall reverse ratio and the 0.5 thrust cap together: reverse is a
    // recovery tool, not a way to set a lap time.
    const forward = await run(false);
    const reversed = await run(true);
    expect(Math.abs(reversed.alongForward)).toBeLessThan(forward.alongForward);
  });
});
