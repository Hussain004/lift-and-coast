import { describe, expect, it } from "vitest";
import { simulateDrive, type TelemetrySample, type WheelTelemetry } from "../lib/ai/harness";
import {
  CHASSIS_HALF_EXTENTS,
  DEFAULT_BRAKE_FORCE,
  DEFAULT_ENGINE_FORCE,
  DEFAULT_STABILIZE_STRENGTH,
} from "../lib/physics/vehicle";
import { computeAIControls } from "../lib/ai/pathFollower";
import { computeRacingLine, type RacingLinePoint } from "../lib/tracks/racingLine";
import silverstone from "../data/tracks/silverstone.json";
import type { TrackData } from "../lib/tracks/types";

/**
 * AI stability telemetry diagnostic (the "per-wheel contact/traction
 * diagnostic" recommended in [[lift_and_coast_ai_boost_knife_edge]] as the
 * next step after three refuted control-law changes).
 *
 * Runs the real AI controller against the real Silverstone trimesh in the
 * headless harness, capturing per-wheel telemetry via simulateDrive's
 * onTelemetry hook (contact flag, suspension force/length, longitudinal and
 * lateral impulses), then prints dense per-step windows around every
 * significant off-track excursion and, with perturbation sweep, the largest
 * impact events - so the physical mechanism (traction loss, wheel-lift,
 * bottom-out...) can be CHARACTERIZED rather than another gain swept blind.
 *
 * The perturbation sweep doubles as the 150s regression guard for the
 * nose-scrape fix (FRONT_MAX_SUSPENSION_TRAVEL): the gains listed below
 * flipped the AI (~1.05 rad) before the fix and are guarded to not flip
 * again, since AI behavior is chaotic-sensitive to one-step changes.
 *
 * Full report (slow, ~4 x 150s sims):  AI_TELEMETRY=1 npx vitest run tests/aiTelemetry.test.ts
 */

const FLIP_THRESHOLD_RAD = 0.6;
const GATED = !process.env.AI_TELEMETRY;

// These cross-track steering gains all flipped the AI (~1.05 rad) during
// the knife-edge investigation - the chassis-nose scrape mechanism that
// FRONT_MAX_SUSPENSION_TRAVEL (see vehicle.ts) then fixed. The sweep below
// guards each gain at a full 150s so the fix can't silently regress.
const CROSS_TRACK_GAINS_TO_TRY = [0.001, -0.001, 0.004];

const WHEEL_NAMES = ["FL", "FR", "RL", "RR"];
const EXCURSION_MIN_OFF_TRACK_METERS = 4;
const WINDOW_HALF_SECONDS = 1.5;

const track = silverstone as TrackData;
const line = computeRacingLine(track);

function nearestLineIndex(linePts: RacingLinePoint[], x: number, z: number): number {
  let nearestIdx = 0;
  let nearestDistSq = Infinity;
  for (let i = 0; i < linePts.length; i++) {
    const [lx, , lz] = linePts[i].position;
    const distSq = (lx - x) ** 2 + (lz - z) ** 2;
    if (distSq < nearestDistSq) {
      nearestDistSq = distSq;
      nearestIdx = i;
    }
  }
  return nearestIdx;
}

/** Signed cross-track error relative to the line's own right vector (positive = drifted right of the line). */
function crossTrackError(linePts: RacingLinePoint[], x: number, z: number): number {
  const n = linePts.length;
  const i = nearestLineIndex(linePts, x, z);
  const [lx, , lz] = linePts[i].position;
  const behind = linePts[(i - 1 + n) % n].position;
  const ahead = linePts[(i + 1) % n].position;
  const tx = ahead[0] - behind[0];
  const tz = ahead[2] - behind[2];
  const len = Math.hypot(tx, tz) || 1;
  const rightX = -tz / len;
  const rightZ = tx / len;
  return (x - lx) * rightX + (z - lz) * rightZ;
}

async function runOnce(seconds: number, crossTrackGain: number | null): Promise<{ samples: TelemetrySample[]; maxTiltRad: number; maxOffTrackMeters: number; distanceTraveledMeters: number }> {
  const samples: TelemetrySample[] = [];
  const result = await simulateDrive(
    seconds,
    (_elapsedSeconds, state) => {
      const controls = computeAIControls(line, state.x, state.z, state.yawRad, state.speedMs);
      if (crossTrackGain === null) return controls;
      return {
        ...controls,
        steer: controls.steer + crossTrackError(line, state.x, state.z) * crossTrackGain,
      };
    },
    {
      engineForce: DEFAULT_ENGINE_FORCE,
      brakeForce: DEFAULT_BRAKE_FORCE,
      stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
      track,
      onTelemetry: (s) => samples.push(s),
      captureChassisContacts: true,
    }
  );
  return {
    samples,
    maxTiltRad: result.maxTiltRad,
    maxOffTrackMeters: result.maxOffTrackMeters,
    distanceTraveledMeters: result.distanceTraveledMeters,
  };
}

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function wheelLine(s: TelemetrySample): string {
  return s.wheels
    .map((w, i) => `${WHEEL_NAMES[i]}:${w.isInContact ? "1" : "0"}·${fmt(w.suspensionForce / 1000, 1)}·${fmt(w.suspensionLength, 2)}·${fmt(w.forwardImpulse, 0)}·${fmt(w.sideImpulse, 0)}`)
    .join(" ");
}

function printWindow(samples: TelemetrySample[], centerSeconds: number, label: string, stepEvery = 3): void {
  const startIdx = Math.max(0, Math.floor((centerSeconds - WINDOW_HALF_SECONDS) * 60));
  const endIdx = Math.min(samples.length, Math.ceil((centerSeconds + WINDOW_HALF_SECONDS) * 60));
  console.log(`\n--- ${label} (t=${fmt(centerSeconds, 2)}s) ---`);
  console.log(` t(s)   v(m/s) tilt   off   y   T  B  S  | ${WHEEL_NAMES.join("         ")}  (contact·kN·len·fImp·sImp)`);
  for (let i = startIdx; i < endIdx && i < samples.length; i += stepEvery) {
    const s = samples[i];
    console.log(
      `${fmt(s.elapsedSeconds, 2).padStart(5)} ${fmt(s.speedMs, 1).padStart(6)} ${fmt(s.tiltRad, 3).padStart(5)} ` +
        `${fmt(s.offTrackMeters, 1).padStart(4)} ${fmt(s.position.y, 2).padStart(5)} ${fmt(s.throttle, 1).padStart(3)} ${fmt(s.brake, 1).padStart(2)} ${fmt(s.steer, 2).padStart(4)} | ${wheelLine(s)}`
    );
  }
  console.log("");
}

function wholeRunStats(samples: TelemetrySample[]): void {
  let airborneSteps = 0;
  const wheelAirborne = [0, 0, 0, 0];
  let rearBottomOutSteps = 0;
  let anyWheelLiftEvents = 0;
  let prevAllDown: boolean | null = null;
  let touchDownCount = 0;
  let minNoseClearance = Infinity;
  let scrapeSteps = 0;
  let worstScrapeSample: TelemetrySample | null = null;

  for (const s of samples) {
    const contacts = s.wheels.map((w) => w.isInContact);
    const anyUp = contacts.some((c) => !c);
    if (anyUp) {
      airborneSteps++;
      contacts.forEach((c, i) => {
        if (!c) wheelAirborne[i]++;
      });
    }
    const allDown = contacts.every(Boolean);
    if (prevAllDown === false && allDown) touchDownCount++;
    prevAllDown = allDown;
    if (!allDown && prevAllDown !== false) anyWheelLiftEvents++;
    const rearBottomed =
      !contacts[2] || !contacts[3] || s.wheels[2].suspensionLength < -0.28 || s.wheels[3].suspensionLength < -0.28;
    if (rearBottomed) rearBottomOutSteps++;
    const nose = chassisLowestCornerMeters(s);
    if (nose < minNoseClearance) {
      minNoseClearance = nose;
      worstScrapeSample = s;
    }
    if (nose < 0) scrapeSteps++;
  }

  const total = samples.length;
  console.log(`\nWhole-run wheel stats (${total} steps = ${fmt(total / 60, 1)}s):`);
  console.log(`  any wheel airborne: ${fmt((100 * airborneSteps) / total, 1)}% (${airborneSteps} steps)`);
  WHEEL_NAMES.forEach((name, i) => {
    console.log(`    ${name}: ${fmt((100 * wheelAirborne[i]) / total, 1)}% (${wheelAirborne[i]} steps)`);
  });
  console.log(`  lift events (all-down -> any-up): ${anyWheelLiftEvents}; touch-downs: ${touchDownCount}`);
  console.log(`  rear bottom-out/airborne: ${rearBottomOutSteps} steps`);
  console.log(
    `  chassis nose scrape: ${scrapeSteps} steps below track surface (min clearance ${fmt(minNoseClearance, 3)}m` +
      (worstScrapeSample ? ` @ t=${fmt(worstScrapeSample.elapsedSeconds, 2)}s v=${fmt(worstScrapeSample.speedMs, 1)}m/s tilt=${fmt(worstScrapeSample.tiltRad, 3)})` : ")")
  );
}

function printRunSummary(run: { maxTiltRad: number; maxOffTrackMeters: number; distanceTraveledMeters: number }, label: string): void {
  console.log(`\n== ${label} ==`);
  console.log(`  maxTiltRad: ${fmt(run.maxTiltRad, 3)}${run.maxTiltRad >= FLIP_THRESHOLD_RAD ? "  <-- FLIP" : ""}`);
  console.log(`  maxOffTrackMeters: ${fmt(run.maxOffTrackMeters, 2)}`);
  console.log(`  distanceTraveled: ${fmt(run.distanceTraveledMeters, 0)}m`);
}

function printExcursionAnalysis(samples: TelemetrySample[]): void {
  const excursions: Array<{ t: number; off: number; tilt: number; v: number }> = [];
  for (let i = 2; i < samples.length - 2; i++) {
    const s = samples[i];
    if (
      s.offTrackMeters > EXCURSION_MIN_OFF_TRACK_METERS &&
      s.offTrackMeters >= samples[i - 1].offTrackMeters &&
      s.offTrackMeters >= samples[i + 1].offTrackMeters
    ) {
      excursions.push({ t: s.elapsedSeconds, off: s.offTrackMeters, tilt: s.tiltRad, v: s.speedMs });
    }
  }
  excursions.sort((a, b) => b.off - a.off);
  console.log(`\nOff-track excursion peaks (>${EXCURSION_MIN_OFF_TRACK_METERS}m): ${excursions.length}`);
  excursions.slice(0, 5).forEach((e) => {
    console.log(`  t=${fmt(e.t, 2)}s  off=${fmt(e.off, 1)}m  tilt=${fmt(e.tilt, 3)}  v=${fmt(e.v, 1)}m/s`);
  });
  excursions.slice(0, 5).forEach((e) => {
    printWindow(samples, e.t, `excursion @ ${fmt(e.t, 2)}s (off=${fmt(e.off, 1)}m)`);
  });

  // Deepest tilt event worth a dense look (0.25 rad = meaningful body roll, below the 0.6 flip bound).
  let worstTiltIdx = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].tiltRad > samples[worstTiltIdx].tiltRad) worstTiltIdx = i;
  }
  const worstTilt = samples[worstTiltIdx];
  if (worstTilt.tiltRad > 0.25) {
    printWindow(samples, worstTilt.elapsedSeconds, `worst tilt @ ${fmt(worstTilt.elapsedSeconds, 2)}s (tilt=${fmt(worstTilt.tiltRad, 3)})`, 1);
  }
}

/**
 * The lowest corner of the chassis cuboid collider (CHASSIS_HALF_EXTENTS
 * [0.9, 0.4, 2] around the body origin), in world meters ABOVE the track
 * surface (y=0). Negative = the nose/rear corner digs BELOW the surface,
 * i.e. the cuboid scrapes/impacts the trimesh instead of riding over it on
 * the suspension. Assumes tiltRad is dominated by pitch (true on this run's
 * straight-line approach: steering < 0.12 rad) and that the dip toward the
 * track is the front OR rear corner (same depth at |pitch|).
 */
function chassisLowestCornerMeters(s: TelemetrySample): number {
  const t = Math.abs(s.tiltRad);
  return (
    s.position.y - CHASSIS_HALF_EXTENTS[1] * Math.cos(t) - CHASSIS_HALF_EXTENTS[2] * Math.sin(t)
  );
}

/**
 * The impact event: the single largest one-step speed drop in the run. If
 * it's an external rigid-body collision, the drop is enormous (tens of m/s
 * in one 1/60s step) while every wheel still reports a normal contact load
 * and only tiny impulses - impossible for wheel forces (4 wheels x ~6 N·s
 * over 1/60s can change a 220kg chassis by ~0.1 m/s).
 */
function printFlipAnalysis(samples: TelemetrySample[]): void {
  let worstDropIdx = -1;
  let worstDrop = 0;
  for (let i = 1; i < samples.length; i++) {
    const drop = samples[i - 1].speedMs - samples[i].speedMs;
    if (drop > worstDrop) {
      worstDrop = drop;
      worstDropIdx = i;
    }
  }
  const at = samples[worstDropIdx];
  const before = samples[worstDropIdx - 1];
  console.log(`\n== LARGEST SINGLE-STEP SPEED DROP ==`);
  console.log(`  t=${fmt(at.elapsedSeconds, 2)}s: ${fmt(before.speedMs, 1)} -> ${fmt(at.speedMs, 1)} m/s (${fmt(worstDrop, 1)} m/s in one 1/60s step)`);
  console.log(`  before: y=${fmt(before.position.y, 2)}m tilt=${fmt(before.tiltRad, 3)} lowest-chassis-corner=${fmt(chassisLowestCornerMeters(before), 3)}m`);
  console.log(`  after:  y=${fmt(at.position.y, 2)}m tilt=${fmt(at.tiltRad, 3)} lowest-chassis-corner=${fmt(chassisLowestCornerMeters(at), 3)}m`);
  console.log(`  contacts (after): ${at.chassisContacts.join(", ") ?? "capture disabled"}`);

  const startIdx = Math.max(0, Math.floor((at.elapsedSeconds - 0.5) * 60));
  const endIdx = Math.min(samples.length, Math.ceil((at.elapsedSeconds + 0.5) * 60));
  console.log(`\n--- impact window (t=${fmt(at.elapsedSeconds, 2)}s) ---`);
  console.log(` t(s)   v(m/s) tilt   off   y   nose  cnt | ${WHEEL_NAMES.join("         ")}  (contact·kN·len·fImp·sImp)`);
  for (let i = startIdx; i < endIdx; i++) {
    const s = samples[i];
    const nose = chassisLowestCornerMeters(s);
    const noseTag = nose < 0 ? `*${fmt(nose, 3)}` : fmt(nose, 3);
    const cnt = s.chassisContacts.join("+") || "-";
    console.log(
      `${fmt(s.elapsedSeconds, 2).padStart(5)} ${fmt(s.speedMs, 1).padStart(6)} ${fmt(s.tiltRad, 3).padStart(5)} ` +
        `${fmt(s.offTrackMeters, 1).padStart(4)} ${fmt(s.position.y, 2).padStart(5)} ${noseTag.padStart(6)} ${cnt.padStart(4)} | ${wheelLine(s)}`
    );
  }
  console.log("");
}

describe.skipIf(GATED)("AI telemetry diagnostic (AI_TELEMETRY=1)", () => {
  it("baseline AI lap: prints per-wheel telemetry around every off-track excursion", async () => {
    const run = await runOnce(150, null);
    expect(run.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
    expect(run.distanceTraveledMeters).toBeGreaterThan(5000);
    printRunSummary(run, "BASELINE (no perturbation), 150s");
    wholeRunStats(run.samples);
    printExcursionAnalysis(run.samples);
  }, 60000);

  it("cross-track gain perturbations no longer flip (150s guard for the nose-scrape fix)", async () => {
    for (const gain of CROSS_TRACK_GAINS_TO_TRY) {
      const run = await runOnce(150, gain);
      printRunSummary(run, `CROSS-TRACK GAIN ${gain}`);
      expect(run.maxTiltRad).toBeLessThan(FLIP_THRESHOLD_RAD);
      expect(run.maxOffTrackMeters).toBeLessThan(25);
      expect(run.distanceTraveledMeters).toBeGreaterThan(5000);
      if (gain === CROSS_TRACK_GAINS_TO_TRY[0]) {
        // Representative post-fix run: whole-run wheel stats (incl. any
        // remaining nose-scrape steps / minimum clearance) plus the largest
        // remaining single-step speed event, to characterize what the AI's
        // most violent moment looks like after the fix.
        wholeRunStats(run.samples);
        printFlipAnalysis(run.samples);
      }
    }
  }, 180000);
});

// Also keep the new harness hook itself permanently tested (cheap, 8s sim),
// so the diagnostic surface can't rot even when the slow gated tests skip.
describe("simulateDrive onTelemetry hook", () => {
  it("fires per-step with all four wheels' contact/suspension/impulse state", async () => {
    const samples: TelemetrySample[] = [];
    await simulateDrive(
      8,
      { throttle: 1, brake: 0, steer: 0 },
      {
        engineForce: DEFAULT_ENGINE_FORCE,
        brakeForce: DEFAULT_BRAKE_FORCE,
        stabilizeStrength: DEFAULT_STABILIZE_STRENGTH,
        track,
        // Blind straight-line run to populate the telemetry buffer; it ends
        // in the run-off, so opt out of the barrier rather than measuring a
        // wall impact instead of suspension state.
        walls: false,
        onTelemetry: (s) => samples.push(s),
        captureChassisContacts: true,
      }
    );
    expect(samples.length).toBeGreaterThan(100); // ~8s at 60Hz
    const last = samples[samples.length - 1];
    expect(last.wheels).toHaveLength(4);
    for (const w of last.wheels as WheelTelemetry[]) {
      expect(typeof w.isInContact).toBe("boolean");
      expect(typeof w.suspensionForce).toBe("number");
      expect(typeof w.suspensionLength).toBe("number");
      expect(typeof w.forwardImpulse).toBe("number");
      expect(typeof w.sideImpulse).toBe("number");
      expect(Number.isFinite(w.suspensionForce)).toBe(true);
      expect(Number.isFinite(w.forwardImpulse)).toBe(true);
      expect(Number.isFinite(w.sideImpulse)).toBe(true);
    }
    // Straight-line full-throttle: all wheels should be firmly in contact
    // with positive suspension load by the end of the run.
    expect(last.wheels.every((w) => w.isInContact)).toBe(true);
    expect(last.wheels.some((w) => w.suspensionForce > 100)).toBe(true);
    expect(last.speedMs).toBeGreaterThan(5);
    // With capture enabled, every sample carries a chassisContacts array
    // (the rigid-body contact partners, distinct from raycast wheel
    // contacts). A normal ride holds the chassis off the ground on its
    // wheels, so it's typically empty - the array itself is the contract.
    expect(Array.isArray(last.chassisContacts)).toBe(true);
    // The flat grass cuboid tops out at y=-0.01, so a correctly riding car's
    // lowest collider corner stays above 0 the whole run - no nose scrape.
    for (const s of samples) {
      expect(
        s.position.y - CHASSIS_HALF_EXTENTS[1] * Math.cos(Math.abs(s.tiltRad)) - CHASSIS_HALF_EXTENTS[2] * Math.sin(Math.abs(s.tiltRad))
      ).toBeGreaterThan(-0.05); // tolerance: 8s straight-line never dips near the scrape threshold
    }
  }, 30000);
});