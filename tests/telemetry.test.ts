import { describe, expect, it } from "vitest";
import {
  BALANCE_LABELS,
  GG_PLOT_MAX_G,
  GRIP_BAR_MIN,
  balanceBias,
  balanceLabel,
  formatG,
  formatLoad,
  formatTemp,
  frontLoadPercent,
  ggPlotPoint,
  gripBarFill,
  slipAngleDeg,
  loadBarFill,
  normalizeBar,
  rpmBarFill,
  type TelemetrySample,
  type WheelTelemetry,
} from "../lib/race/telemetry";
import { STATIC_WHEEL_LOAD_N } from "../lib/physics/vehicle";

const STATIC = STATIC_WHEEL_LOAD_N;

function wheel(over: Partial<WheelTelemetry> = {}): WheelTelemetry {
  return { loadN: STATIC, grip: 1, inContact: true, temperatureC: 90, ...over };
}

/** A neutral car: even load, even grip, on the ground everywhere. */
function sample(over: Partial<TelemetrySample> = {}): TelemetrySample {
  return {
    wheels: {
      frontLeft: wheel(),
      frontRight: wheel(),
      rearLeft: wheel(),
      rearRight: wheel(),
    },
    lateralG: 0,
    longitudinalG: 0,
    totalLoadN: STATIC * 4,
    slipAngleDeg: 0,
    yawRateDegS: 0,
    rpm: 8000,
    redlineRpm: 12000,
    ...over,
  };
}

describe("normalizeBar", () => {
  it("maps a range onto 0..1 and clamps outside it", () => {
    expect(normalizeBar(5, 0, 10)).toBe(0.5);
    expect(normalizeBar(0, 0, 10)).toBe(0);
    expect(normalizeBar(10, 0, 10)).toBe(1);
    expect(normalizeBar(-3, 0, 10)).toBe(0);
    expect(normalizeBar(99, 0, 10)).toBe(1);
  });

  it("is 0 rather than NaN for a degenerate or non-finite range", () => {
    expect(normalizeBar(5, 3, 3)).toBe(0);
    expect(normalizeBar(Number.NaN, 0, 10)).toBe(0);
    expect(normalizeBar(5, 0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("gripBarFill", () => {
  it("spreads the real grip range across the bar instead of pinning it high", () => {
    // A 0..1 scale would show every normal corner as nearly full; the bar is
    // deliberately zoomed to the range a car actually lives in.
    expect(gripBarFill(1)).toBe(1);
    expect(gripBarFill(GRIP_BAR_MIN)).toBe(0);
    expect(gripBarFill(0.7)).toBeGreaterThan(0.3);
    expect(gripBarFill(0.7)).toBeLessThan(0.6);
  });

  it("clamps a worn or wet corner to the bottom of the bar", () => {
    expect(gripBarFill(0.2)).toBe(0);
    expect(gripBarFill(Number.NaN)).toBe(0);
  });
});

describe("loadBarFill", () => {
  it("reads half height at the static corner load", () => {
    // A real corner carries well over static in a fast corner, so the bar is
    // scaled to twice static: half height is the neutral reference.
    expect(loadBarFill(STATIC, STATIC)).toBeCloseTo(0.5, 12);
    expect(loadBarFill(STATIC * 2, STATIC)).toBe(1);
    expect(loadBarFill(0, STATIC)).toBe(0);
  });

  it("is 0 for a corner carrying nothing, and safe on a bad static figure", () => {
    expect(loadBarFill(0, STATIC)).toBe(0);
    expect(loadBarFill(500, 0)).toBe(0);
  });
});

describe("frontLoadPercent", () => {
  it("is 50% for an evenly loaded car and reads the front axle share", () => {
    expect(frontLoadPercent(sample())).toBeCloseTo(50, 6);
    const noseDive = sample({
      wheels: {
        frontLeft: wheel({ loadN: STATIC * 2 }),
        frontRight: wheel({ loadN: STATIC * 2 }),
        rearLeft: wheel({ loadN: STATIC * 0.5 }),
        rearRight: wheel({ loadN: STATIC * 0.5 }),
      },
      totalLoadN: STATIC * 5,
    });
    expect(frontLoadPercent(noseDive)).toBeCloseTo((4 * STATIC) / (5 * STATIC) * 100, 6);
  });

  it("is 50 rather than NaN when nothing is touching the ground", () => {
    expect(frontLoadPercent(sample({ totalLoadN: 0 }))).toBe(50);
  });
});

describe("balanceBias", () => {
  it("reads neutral for an evenly loaded car on even grip", () => {
    expect(balanceBias(sample())).toBeCloseTo(0, 12);
    expect(balanceLabel(balanceBias(sample()))).toBe("NEUTRAL");
  });

  it("reads understeer when the front has lost grip the rear still has", () => {
    const understeer = sample({
      wheels: {
        frontLeft: wheel({ grip: 0.5 }),
        frontRight: wheel({ grip: 0.5 }),
        rearLeft: wheel({ grip: 1 }),
        rearRight: wheel({ grip: 1 }),
      },
    });
    const bias = balanceBias(understeer);
    expect(bias).toBeLessThan(0);
    expect(balanceLabel(bias)).toBe("UNDERSTEER");
  });

  it("reads oversteer as the reverse", () => {
    const oversteer = sample({
      wheels: {
        frontLeft: wheel({ grip: 1 }),
        frontRight: wheel({ grip: 1 }),
        rearLeft: wheel({ grip: 0.5 }),
        rearRight: wheel({ grip: 0.5 }),
      },
    });
    const bias = balanceBias(oversteer);
    expect(bias).toBeGreaterThan(0);
    expect(balanceLabel(bias)).toBe("OVERSTEER");
  });

  it("stays inside -1..1 however lopsided the car is", () => {
    // All load and grip on the rear: the front has nothing left, which is the
    // definition of understeer, so this pins the negative extreme.
    const allRear = sample({
      wheels: {
        frontLeft: wheel({ grip: 0, loadN: 0 }),
        frontRight: wheel({ grip: 0, loadN: 0 }),
        rearLeft: wheel({ grip: 1, loadN: STATIC * 4 }),
        rearRight: wheel({ grip: 1, loadN: STATIC * 4 }),
      },
      totalLoadN: STATIC * 8,
    });
    expect(balanceBias(allRear)).toBeLessThanOrEqual(-1);
    expect(balanceBias(allRear)).toBeLessThan(-0.9);
    // ...and the mirror image is the positive extreme.
    const allFront = sample({
      wheels: {
        frontLeft: wheel({ grip: 1, loadN: STATIC * 4 }),
        frontRight: wheel({ grip: 1, loadN: STATIC * 4 }),
        rearLeft: wheel({ grip: 0, loadN: 0 }),
        rearRight: wheel({ grip: 0, loadN: 0 }),
      },
      totalLoadN: STATIC * 8,
    });
    expect(balanceBias(allFront)).toBe(1);
  });

  it("is 0 when the car is airborne, not a division by zero", () => {
    expect(balanceBias(sample({ totalLoadN: 0 }))).toBe(0);
  });

  it("covers every bias with a label", () => {
    for (const band of BALANCE_LABELS) {
      expect(typeof band.label).toBe("string");
      expect(band.label.length).toBeGreaterThan(0);
    }
    expect(balanceLabel(-1)).toBe("UNDERSTEER");
    expect(balanceLabel(1)).toBe("OVERSTEER");
    // The bands must tile the range in order, or a middle value falls through.
    for (let i = 1; i < BALANCE_LABELS.length; i++) {
      expect(BALANCE_LABELS[i].max).toBeGreaterThan(BALANCE_LABELS[i - 1].max);
    }
  });
});

describe("slipAngleDeg", () => {
  it("is zero when the car is going exactly where it points", () => {
    // At yaw 0 forward is (0, -1) and right is (1, 0), so straight ahead is
    // a negative-z velocity.
    expect(slipAngleDeg(0, 0, -10)).toBeCloseTo(0, 9);
  });

  it("is positive when the car slides toward its right", () => {
    // 10 m/s at 30 degrees right of straight ahead.
    expect(slipAngleDeg(0, 5, -10 * Math.cos(Math.PI / 6))).toBeCloseTo(30, 6);
  });

  it("is negative sliding the other way", () => {
    expect(slipAngleDeg(0, -5, -10 * Math.cos(Math.PI / 6))).toBeCloseTo(-30, 6);
  });

  it("follows the car's heading, not the world's", () => {
    // At yaw -90 the car points along +x, so its right is +z. A velocity with
    // a positive z component is therefore sliding to the car's RIGHT and must
    // read positive, whatever the world axes say.
    expect(slipAngleDeg(-Math.PI / 2, 10, 5)).toBeGreaterThan(0);
    expect(slipAngleDeg(-Math.PI / 2, 10, -5)).toBeLessThan(0);
    expect(slipAngleDeg(-Math.PI / 2, 10, 0)).toBeCloseTo(0, 9);
  });

  it("stays still below walking pace rather than reading heading noise", () => {
    expect(slipAngleDeg(0.7, 0.1, -0.1)).toBe(0);
  });

  it("does not wrap to 180 when the car is rolling backwards", () => {
    // atan2 would give 180 here, which would make the readout snap the
    // instant a car spun or reversed.
    expect(slipAngleDeg(0, 0, 10)).toBe(0);
    expect(slipAngleDeg(0, 8, 8)).toBe(0);
  });
});

describe("formatG", () => {
  it("keeps a fixed sign column so the digits do not jitter as the value moves", () => {
    expect(formatG(0)).toBe("+0.0");
    expect(formatG(1.24)).toBe("+1.2");
    expect(formatG(-1.24)).toBe("-1.2");
    // Same width either side of zero - a sign that changes length is what
    // makes a live readout shimmer.
    expect(formatG(0.5).length).toBe(formatG(-0.5).length);
    expect(formatG(4.9).length).toBe(formatG(-4.9).length);
  });

  it("falls back rather than printing NaN", () => {
    expect(formatG(Number.NaN)).toBe("+0.0");
  });
});

describe("formatLoad", () => {
  it("shows kilonewtons with one decimal", () => {
    expect(formatLoad(0)).toBe("0.0kN");
    expect(formatLoad(1500)).toBe("1.5kN");
    expect(formatLoad(STATIC)).toBe(`${(STATIC / 1000).toFixed(1)}kN`);
    expect(formatLoad(Number.NaN)).toBe("0.0kN");
  });
});

describe("formatTemp", () => {
  it("rounds to whole degrees and degrades gracefully", () => {
    expect(formatTemp(90.4)).toBe("90°");
    expect(formatTemp(88.6)).toBe("89°");
    expect(formatTemp(Number.NaN)).toBe("--");
  });
});

describe("ggPlotPoint", () => {
  it("puts the centre of the plot at no acceleration", () => {
    expect(ggPlotPoint(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it("scales to the box's half-extent at the real g limit", () => {
    const edge = ggPlotPoint(GG_PLOT_MAX_G, 0);
    expect(edge.x).toBeCloseTo(1, 12);
    expect(edge.y).toBeCloseTo(0, 12);
  });

  it("pins beyond the limit to the edge instead of vanishing off-plot", () => {
    const beyond = ggPlotPoint(GG_PLOT_MAX_G * 4, 0);
    expect(beyond.x).toBe(1);
    const beyondNeg = ggPlotPoint(-GG_PLOT_MAX_G * 4, 0);
    expect(beyondNeg.x).toBe(-1);
  });
});

describe("rpmBarFill", () => {
  it("fills to the redline", () => {
    expect(rpmBarFill(0, 12000)).toBe(0);
    expect(rpmBarFill(12000, 12000)).toBe(1);
    expect(rpmBarFill(6000, 12000)).toBe(0.5);
    // Past the redline must stay full, not overflow the bar.
    expect(rpmBarFill(15000, 12000)).toBe(1);
  });
});
