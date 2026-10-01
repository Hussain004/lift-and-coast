import { describe, expect, it } from "vitest";
import {
  AERO_TRIM_MAX,
  AERO_TRIM_MIN,
  DEFAULT_CAR_SETUP,
  RIDE_HEIGHT_MAX,
  RIDE_HEIGHT_MIN,
  aeroDownforceScale,
  aeroDragScale,
  carSetupLabel,
  isDefaultCarSetup,
  normalizeCarSetup,
  rideHeightDownforceScale,
  setupDownforceScale,
  setupDragScale,
  setupFinalDriveScale,
  setupTyreGripScale,
  TYRE_PRESSURE_NOMINAL,
  type CarSetup,
} from "../lib/physics/carSetup";
import { pressureWarmupTimeConstantSeconds } from "../lib/race/strategy";
import { computeDownforceN, computeDragN } from "../lib/physics/aero";
import { FINAL_DRIVE_MAX, FINAL_DRIVE_MIN } from "../lib/physics/gearbox";
import { parseCarSetup, buildRaceUrl } from "../lib/race/sessionSetup";

describe("car setup model", () => {
  it("defaults to the neutral build the AI runs", () => {
    expect(isDefaultCarSetup(DEFAULT_CAR_SETUP)).toBe(true);
    // Neutral must be an exact no-op: at nominal ride height and full aero
    // trim both scales are 1, and the final drive and tyre pressure resolve
    // to their identities, so a player who never opens the setup screen
    // drives a bit-for-bit identical car.
    expect(rideHeightDownforceScale(DEFAULT_CAR_SETUP.rideHeight)).toBe(1);
    expect(aeroDownforceScale(DEFAULT_CAR_SETUP)).toBe(1);
    expect(setupDownforceScale(DEFAULT_CAR_SETUP)).toBe(1);
    expect(setupFinalDriveScale(DEFAULT_CAR_SETUP)).toBe(1);
    expect(setupTyreGripScale(DEFAULT_CAR_SETUP)).toBe(1);
    expect(pressureWarmupTimeConstantSeconds(DEFAULT_CAR_SETUP.tyrePressure)).toBe(
      pressureWarmupTimeConstantSeconds(undefined)
    );
  });

  it("treats a setup blob written before the new sliders existed as neutral", () => {
    // A prefs entry saved by an earlier build has no finalDrive or
    // tyrePressure key at all. It must come back as the neutral build, not
    // as undefined reaching the gearbox.
    const old = normalizeCarSetup({ rideHeight: 0.3, aeroTrim: 0.8 });
    expect(old.finalDrive).toBe(1);
    expect(old.tyrePressure).toBe(TYRE_PRESSURE_NOMINAL);
    // ...and the STANDARD button's selected state has to agree, or the
    // setup screen would show a customised build as standard.
    expect(isDefaultCarSetup({ rideHeight: 0.3, aeroTrim: 0.8 })).toBe(false);
    expect(isDefaultCarSetup({ ...old, finalDrive: 0.97 })).toBe(false);
  });

  it("totalises anything untrusted rather than throwing or emitting NaN", () => {
    // These arrive from a URL (?rh= / ?at=) and from a localStorage blob
    // written by an older build, so every one of these is reachable.
    expect(normalizeCarSetup(null)).toEqual(DEFAULT_CAR_SETUP);
    expect(normalizeCarSetup(undefined)).toEqual(DEFAULT_CAR_SETUP);
    expect(normalizeCarSetup({})).toEqual(DEFAULT_CAR_SETUP);
    for (const bad of [NaN, Infinity, -Infinity, "0.5" as unknown as number, {} as unknown as number]) {
      const out = normalizeCarSetup({ rideHeight: bad, aeroTrim: bad });
      expect(Number.isFinite(out.rideHeight)).toBe(true);
      expect(Number.isFinite(out.aeroTrim)).toBe(true);
    }
  });

  it("clamps to its declared range", () => {
    expect(normalizeCarSetup({ rideHeight: -5, aeroTrim: 9 }).rideHeight).toBe(RIDE_HEIGHT_MIN);
    expect(normalizeCarSetup({ rideHeight: -5, aeroTrim: 9 }).aeroTrim).toBe(AERO_TRIM_MAX);
  });

  it("never produces a negative or zero force multiplier", () => {
    // A negative downforce scale would be an upward force; zero would be a
    // car that generates no grip at all. Both are far worse than a weak setup.
    for (let k = 0; k <= 20; k += 1) {
      const setup: CarSetup = {
        rideHeight: k / 20,
        aeroTrim: k / 20,
      };
      expect(setupDownforceScale(setup)).toBeGreaterThan(0.5);
      expect(setupDragScale(setup)).toBeGreaterThan(0.5);
    }
  });

  it("is monotonic: lower ride height means more downforce, more trim means more of both terms", () => {
    let previous = Infinity;
    for (let k = 0; k <= 20; k += 1) {
      const scale = rideHeightDownforceScale(k / 20);
      expect(scale).toBeLessThanOrEqual(previous);
      previous = scale;
    }
    let previousDown = -Infinity;
    let previousDrag = -Infinity;
    for (let k = 0; k <= 20; k += 1) {
      const setup: CarSetup = { rideHeight: RIDE_HEIGHT_MIN, aeroTrim: k / 20 };
      expect(aeroDownforceScale(setup)).toBeGreaterThanOrEqual(previousDown);
      expect(aeroDragScale(setup)).toBeGreaterThanOrEqual(previousDrag);
      previousDown = aeroDownforceScale(setup);
      previousDrag = aeroDragScale(setup);
    }
  });

  it("keeps the whole slider a setup, not a different car", () => {
    // The bounds the module documents: the extremes are a double-digit
    // percentage either way of the validated reference, which is what stops
    // the setup from invalidating the measured speed profile.
    const lowest = setupDownforceScale({ rideHeight: RIDE_HEIGHT_MIN, aeroTrim: AERO_TRIM_MAX });
    const highest = setupDownforceScale({ rideHeight: RIDE_HEIGHT_MAX, aeroTrim: AERO_TRIM_MAX });
    expect(lowest).toBeLessThan(1.2);
    expect(highest).toBeGreaterThan(0.8);
  });
});

describe("setup reaches the existing aero terms as a multiplier", () => {
  it("leaves the untouched path bit-identical", () => {
    // The default scale argument is 1, which is what every existing caller
    // (racingLine.ts's AI lateral-accel estimate included) relies on.
    for (const speed of [0, 10, 30, 60, 90]) {
      expect(computeDownforceN(speed, "high-downforce")).toBe(
        computeDownforceN(speed, "high-downforce", 1)
      );
      expect(computeDragN(speed, "high-downforce")).toBe(computeDragN(speed, "high-downforce", 1));
    }
  });

  it("scales both terms in the same direction as the setup", () => {
    const reference = computeDownforceN(60, "high-downforce");
    expect(computeDownforceN(60, "high-downforce", 1.1)).toBeGreaterThan(reference);
    expect(computeDownforceN(60, "high-downforce", 0.9)).toBeLessThan(reference);
  });
});

describe("setup travels on the race URL", () => {
  it("omits the default, so existing links are unchanged", () => {
    const url = buildRaceUrl({ mode: "race", track: "monza" });
    expect(url).not.toContain("rh=");
    expect(url).not.toContain("at=");
  });

  it("emits only what differs from neutral", () => {
    const url = buildRaceUrl({
      mode: "race",
      track: "monza",
      rideHeight: DEFAULT_CAR_SETUP.rideHeight,
      aeroTrim: 0.4,
    });
    expect(url).not.toContain("rh=");
    expect(url).toContain("at=0.40");
  });

  it("round-trips a custom setup through the URL", () => {
    const setup: CarSetup = {
      rideHeight: 0.2,
      aeroTrim: 0.75,
      finalDrive: 0.97,
      tyrePressure: 0.3,
    };
    const url = buildRaceUrl({ mode: "race", track: "spa", ...setup });
    const params = new URLSearchParams(url.split("?")[1]);
    expect(
      parseCarSetup(params.get("rh"), params.get("at"), {
        finalDrive: params.get("fd"),
        tyrePressure: params.get("tp"),
      })
    ).toEqual(setup);
  });

  it("omits the new sliders at their defaults, so existing links are unchanged", () => {
    // A default setup adds nothing to the URL: the same rule the first two
    // sliders follow, and the reason every pre-existing shared link still
    // opens on exactly the car it did before.
    const url = buildRaceUrl({
      mode: "race",
      track: "monza",
      ...DEFAULT_CAR_SETUP,
    });
    expect(url).not.toContain("fd=");
    expect(url).not.toContain("tp=");
  });

  it("reads the two new URL params and totalises junk in them", () => {
    const parsed = parseCarSetup(null, null, { finalDrive: "1.02", tyrePressure: "0.2" });
    expect(parsed.finalDrive).toBe(1.02);
    expect(parsed.tyrePressure).toBe(0.2);
    // Blank, junk and out-of-range all fall back or clamp rather than
    // producing a half-applied setup.
    expect(parseCarSetup(null, null, { finalDrive: "", tyrePressure: "banana" })).toEqual(
      DEFAULT_CAR_SETUP
    );
    expect(parseCarSetup(null, null, { finalDrive: "9" }).finalDrive).toBe(FINAL_DRIVE_MAX);
    expect(parseCarSetup(null, null, { finalDrive: "-9" }).finalDrive).toBe(FINAL_DRIVE_MIN);
  });

  it("falls back to the neutral setup for a missing or junk value", () => {
    expect(parseCarSetup(null, null)).toEqual(DEFAULT_CAR_SETUP);
    expect(parseCarSetup("banana", "")).toEqual(DEFAULT_CAR_SETUP);
    // Out of range, but finite: clamped rather than rejected, so a shared
    // link from a future build with a wider range still drives a sane car.
    expect(parseCarSetup("5", "-5").rideHeight).toBe(RIDE_HEIGHT_MAX);
    expect(parseCarSetup("5", "-5").aeroTrim).toBe(AERO_TRIM_MIN);
  });
});

describe("car setup label", () => {
  it("describes the character rather than the numbers", () => {
    expect(carSetupLabel(DEFAULT_CAR_SETUP)).toContain("STANDARD");
    expect(carSetupLabel({ rideHeight: 0, aeroTrim: 0 })).toBe("LOW · LOW DRAG");
    expect(carSetupLabel({ rideHeight: 1, aeroTrim: 1 })).toBe("HIGH · MAX DOWNFORCE");
  });
});
