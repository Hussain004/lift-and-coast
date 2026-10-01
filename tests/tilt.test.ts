import { describe, expect, it } from "vitest";
import {
  TILT_DEADZONE_FRACTION,
  TILT_RANGE_DEGREES,
  calibrateTilt,
  createTiltCalibration,
  isTiltSupported,
  normalizeScreenAngle,
  requestTiltPermission,
  tiltAxisDegrees,
  tiltSteer,
  type ScreenAngle,
  type TiltReading,
} from "../lib/input/tilt";

/**
 * Roadmap 13: tilt steering.
 *
 * The axis selection and the sign convention are mechanical and fully testable
 * here. The one thing that genuinely cannot be tested in this file is whether
 * a real phone reports the rotation the way the axis table assumes - that
 * needs a device, which is why the sign is a persisted setting rather than a
 * constant (see the module header). Everything below is the part that is
 * decidable without hardware, and the calibration behaviour is the part that
 * would quietly ruin the control if it were wrong.
 */

const reading = (gamma: number, beta: number): TiltReading => ({ gamma, beta });

describe("screen angle normalisation", () => {
  it("collapses the two spellings of the same rotation", () => {
    // The DOM reports -90 on some browsers and 270 on others for the same
    // physical rotation. Anything that compares against 270 without
    // normalising first silently falls through to the portrait branch.
    expect(normalizeScreenAngle(-90)).toBe(270);
    expect(normalizeScreenAngle(90)).toBe(90);
    expect(normalizeScreenAngle(270)).toBe(270);
    expect(normalizeScreenAngle(0)).toBe(0);
    expect(normalizeScreenAngle(180)).toBe(180);
  });

  it("rounds and tolerates nonsense", () => {
    expect(normalizeScreenAngle(89)).toBe(90);
    expect(normalizeScreenAngle(44)).toBe(0);
    expect(normalizeScreenAngle(NaN)).toBe(0);
    expect(normalizeScreenAngle(null)).toBe(0);
    expect(normalizeScreenAngle(undefined)).toBe(0);
  });
});

describe("axis selection", () => {
  it("uses gamma in portrait and beta in landscape, negated upside down", () => {
    const r = reading(20, 35);
    expect(tiltAxisDegrees(r, 0)).toBe(20);
    expect(tiltAxisDegrees(r, 90)).toBe(35);
    expect(tiltAxisDegrees(r, 180)).toBe(-20);
    expect(tiltAxisDegrees(r, 270)).toBe(-35);
  });

  it("is zero for a broken reading rather than NaN", () => {
    // One NaN reading must not poison the steer value for a frame, because a
    // NaN steer reaching the vehicle controller is a permanently stuck wheel.
    expect(tiltAxisDegrees(reading(NaN, 10), 0)).toBe(0);
    expect(tiltAxisDegrees(reading(10, NaN), 90)).toBe(0);
    expect(tiltAxisDegrees(reading(Infinity, 10), 0)).toBe(0);
  });

  it("rotates the axis with the device", () => {
    // The same physical roll read in four orientations must produce the same
    // MAGNITUDE, or the steering would feel different depending on how the
    // player happens to be holding the phone.
    const r = reading(12, 12);
    for (const angle of [0, 90, 180, 270] as ScreenAngle[]) {
      expect(Math.abs(tiltAxisDegrees(r, angle))).toBe(12);
    }
  });
});

describe("calibration", () => {
  it("does not steer before calibration", () => {
    // The important one. A player who opens a session lying down must not
    // find the car already turning.
    const calibration = createTiltCalibration();
    expect(tiltSteer(calibration, reading(20, 0), 0)).toBe(0);
    expect(calibration.calibrated).toBe(false);
  });

  it("neutralises whatever pose the phone was held in", () => {
    // Calibrating while lying back at 60 degrees has to make that the new
    // zero, so 60 degrees now means "straight ahead".
    const calibration = createTiltCalibration();
    calibrateTilt(calibration, reading(60, 0), 0);
    expect(calibration.calibrated).toBe(true);
    expect(tiltSteer(calibration, reading(60, 0), 0)).toBe(0);
    // ...and tilting from there steers normally.
    expect(tiltSteer(calibration, reading(70, 0), 0)).not.toBe(0);
  });

  it("calibrates on the chosen axis, not always gamma", () => {
    const calibration = createTiltCalibration();
    calibrateTilt(calibration, reading(5, 40), 90);
    // In landscape the neutral is the beta reading; gamma must not leak in.
    expect(tiltSteer(calibration, reading(5, 40), 90)).toBe(0);
    expect(tiltSteer(calibration, reading(40, 40), 90)).toBe(0);
  });

  it("recalibrating moves the zero", () => {
    const calibration = createTiltCalibration();
    calibrateTilt(calibration, reading(0, 0), 0);
    expect(tiltSteer(calibration, reading(TILT_RANGE_DEGREES, 0), 0)).not.toBe(0);
    calibrateTilt(calibration, reading(TILT_RANGE_DEGREES, 0), 0);
    expect(tiltSteer(calibration, reading(TILT_RANGE_DEGREES, 0), 0)).toBe(0);
  });
});

describe("steering from a reading", () => {
  const calibratedAtZero = (angle: ScreenAngle = 0) => {
    const c = createTiltCalibration();
    calibrateTilt(c, reading(0, 0), angle);
    return c;
  };

  it("uses the vehicle's left-positive convention", () => {
    // The game, the gamepad and the touch stick all treat positive as left.
    // Tilt has to agree, or a player switching input method drives into the
    // wall. Browser gamma is positive for a clockwise roll, which is a RIGHT
    // turn, so a positive reading must come out negative.
    const c = calibratedAtZero();
    expect(tiltSteer(c, reading(-10, 0), 0)).toBeGreaterThan(0);
    expect(tiltSteer(c, reading(10, 0), 0)).toBeLessThan(0);
  });

  it("is inside a dead zone at rest, so the car does not wander", () => {
    // A phone on a desk still reports a degree or two. That must read as
    // straight ahead, not as a slow permanent turn.
    const c = calibratedAtZero();
    const drift = TILT_RANGE_DEGREES * TILT_DEADZONE_FRACTION * 0.8;
    expect(tiltSteer(c, reading(drift, 0), 0)).toBe(0);
    expect(tiltSteer(c, reading(-drift, 0), 0)).toBe(0);
    // Just outside it, steering starts.
    const outside = TILT_RANGE_DEGREES * TILT_DEADZONE_FRACTION * 1.5;
    expect(tiltSteer(c, reading(outside, 0), 0)).not.toBe(0);
  });

  it("reaches full lock at the range and clamps beyond it", () => {
    const c = calibratedAtZero();
    const full = tiltSteer(c, reading(-TILT_RANGE_DEGREES, 0), 0);
    expect(full).toBe(1);
    expect(tiltSteer(c, reading(-TILT_RANGE_DEGREES * 4, 0), 0)).toBe(1);
    expect(tiltSteer(c, reading(TILT_RANGE_DEGREES, 0), 0)).toBe(-1);
    expect(tiltSteer(c, reading(TILT_RANGE_DEGREES * 4, 0), 0)).toBe(-1);
  });

  it("is monotonic through the range", () => {
    const c = calibratedAtZero();
    // Sweeping the reading from hard-left to hard-right, the steer value has
    // to fall from +1 to -1 without going back up: a non-monotonic curve is
    // what makes a wheel feel like it has a notch in it.
    let previous = Infinity;
    for (let d = -TILT_RANGE_DEGREES; d <= TILT_RANGE_DEGREES; d += 1) {
      const steer = tiltSteer(c, reading(d, 0), 0);
      expect(steer).toBeLessThanOrEqual(previous);
      previous = steer;
    }
    // ...and it actually spans the full range rather than a narrow band.
    expect(tiltSteer(c, reading(-TILT_RANGE_DEGREES, 0), 0)).toBeGreaterThan(0.9);
    expect(tiltSteer(c, reading(TILT_RANGE_DEGREES, 0), 0)).toBeLessThan(-0.9);
  });

  it("shapes the response, so the first degrees are the finest", () => {
    // Same curve as the stick and the pad, so the control does not feel
    // different to learn.
    const c = calibratedAtZero();
    const quarter = Math.abs(tiltSteer(c, reading(-TILT_RANGE_DEGREES * 0.25, 0), 0));
    const half = Math.abs(tiltSteer(c, reading(-TILT_RANGE_DEGREES * 0.5, 0), 0));
    expect(quarter).toBeLessThan(half);
  });

  it("steers the same in landscape as in portrait for the same roll", () => {
    // Held flat in portrait the roll axis is gamma; rotated to landscape it is
    // beta. The magnitudes must match or the car feels different per rotation.
    const portrait = calibratedAtZero(0);
    const landscape = calibratedAtZero(90);
    expect(Math.abs(tiltSteer(portrait, reading(-10, 0), 0))).toBeCloseTo(
      Math.abs(tiltSteer(landscape, reading(0, -10), 90)),
      6
    );
  });

  it("inverts cleanly for a device that reports the other way", () => {
    // This is the escape hatch for the one part of the mapping that cannot be
    // verified without hardware: a player flips it rather than editing a
    // constant. It must be a true mirror, not an approximation.
    const c = calibratedAtZero();
    for (const d of [3, 7, 12, 20]) {
      expect(tiltSteer(c, reading(d, 0), 0, { invert: true })).toBeCloseTo(
        -tiltSteer(c, reading(d, 0), 0),
        10
      );
    }
  });

  it("never returns a non-finite or out-of-range value", () => {
    const c = calibratedAtZero();
    for (const bad of [NaN, Infinity, -Infinity]) {
      const steer = tiltSteer(c, reading(bad, bad), 0);
      expect(Number.isFinite(steer)).toBe(true);
      expect(Math.abs(steer)).toBeLessThanOrEqual(1);
    }
    expect(tiltSteer(c, reading(0, 0), 0, { rangeDegrees: 0 })).toBe(0);
  });
});

describe("capability and permission", () => {
  it("reports tilt as unsupported when the API is missing", () => {
    // On a desktop this is what stops the player being offered a control that
    // silently does nothing.
    expect(isTiltSupported(null)).toBe(false);
    expect(isTiltSupported({})).toBe(false);
    expect(isTiltSupported({ DeviceOrientationEvent: class {} } as never)).toBe(true);
  });

  it("treats a missing requestPermission as already permitted", () => {
    // Android and desktop Chrome have no permission gate at all, so this must
    // not block them.
    return expect(requestTiltPermission()).resolves.toBe(true);
  });

  it("reports a refused permission as refused rather than throwing", async () => {
    const original = (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent;
    (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
      requestPermission: () => Promise.resolve("denied"),
    };
    try {
      await expect(requestTiltPermission()).resolves.toBe(false);
      (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = {
        requestPermission: () => Promise.reject(new Error("not a gesture")),
      };
      // A browser that throws instead of resolving is a normal outcome; it
      // must fall back to sticks, not take the session down.
      await expect(requestTiltPermission()).resolves.toBe(false);
    } finally {
      (globalThis as { DeviceOrientationEvent?: unknown }).DeviceOrientationEvent = original;
    }
  });
});
