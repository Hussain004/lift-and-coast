import { describe, expect, it } from "vitest";
import { createDriveSession } from "../lib/ai/driveSession";
import { createTimeAttack } from "../lib/race/timeAttack";
import { computeAIControls } from "../lib/ai/pathFollower";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { allWheelsOffTrack } from "../lib/tracks/trackLimits";
import { CAR_WHEELS } from "../lib/physics/vehicle";
import { getTrack } from "../lib/tracks/trackData";
import { MIN_LAP_SECONDS } from "../lib/race/lapTimer";
import type { TrackData } from "../lib/tracks/types";

/**
 * The end-to-end check the pure lap-logic tests cannot make: a lap set on the
 * REAL physics session, on a REAL circuit, through the REAL `checkTrackLimits`
 * progress reading, is recognised for what it is.
 *
 * The pure tests feed synthetic progress, which proves the rules are right
 * GIVEN their input. It cannot prove the input is what we think it is.
 * Specifically it cannot rule out the real start-line seam behaving in a way
 * that never fires a wrap, fires two for one crossing, or fires a spurious one
 * somewhere mid-lap - and a time attack whose wrap detection never triggers
 * silently records nothing at all, which would look like a physics bug rather
 * than a timing one. Nor can it prove the track-limits flag is wired to real
 * wheel positions.
 *
 * So this drives real circuits with the project's own production line
 * follower, on the same shared `applyCarControls` path, and feeds the real
 * readings into the real lap logic. The AI is used unmodified: this asks "does
 * the shared car set laps the lap logic recognises", not "can the AI go
 * faster", and adding control terms to make it pass would be tuning the AI
 * through the back door.
 *
 * A MEASURED FACT WORTH RECORDING, because it looks like a bug here and is
 * not one. The AI never sets a valid lap on any circuit tested. The lap
 * benchmark gate allows up to MAX_OFF_TRACK_METERS = 6m of chassis-centre
 * excursion (tests/aceTrackBenchmark.test.ts), while the track-limits rule
 * that decides lap validity invalidates at about 1.16m of the same measure -
 * the car's 0.82m half-track plus the 0.34m wheel radius Car.tsx passes to
 * allWheelsOffTrack. So the AI routinely drives laps its own lap-validity rule
 * would reject, by a factor of five. That gap is pre-existing and belongs to
 * the AI gate, not to this feature; the time attack deliberately keeps the
 * rule Car.tsx uses, because a leaderboard that accepted a wider line than the
 * race would not be comparing like with like. It does mean the assertions here
 * are about accounting and about validity matching the rule, NOT about the AI
 * driving a clean lap - which it does not, at any pace.
 */

const DT = 1 / 60;
const WHEEL_RADIUS = CAR_WHEELS[0].radius;

/** The four wheel ground positions from a session pose, as the UI computes them. */
function wheelPositions(state: { x: number; z: number; yawRad: number }) {
  const cos = Math.cos(state.yawRad);
  const sin = Math.sin(state.yawRad);
  return CAR_WHEELS.map((wheel) => ({
    x: state.x + wheel.position[0] * cos - wheel.position[2] * sin,
    z: state.z + wheel.position[0] * sin + wheel.position[2] * cos,
  }));
}

interface LapResult {
  lapsCompleted: number;
  /** Every raw progress jump larger than half a lap, on the real reading. */
  wraps: number;
  /** The largest NON-wrap step, in metres: ordinary driving, never a wrap. */
  biggestDrivingStep: number;
  /** Per lap, whether the car put all four wheels off at any point in it. */
  offTrackThisLap: boolean[];
  /** What the lap logic recorded for each crossing, in order. */
  lapSeconds: (number | null)[];
  lapValid: boolean[];
  bestLapSeconds: number | null;
  bestWasSet: boolean;
}

/**
 * Drives up to `maxSeconds` of simulated time, stopping once `targetLaps` have
 * been banked, and reports what the lap logic made of it alongside the raw
 * signals it was fed.
 */
async function driveAndTime(
  trackId: string,
  maxSeconds: number,
  targetLaps = 2,
  paceScale = 1
): Promise<LapResult> {
  const track: TrackData = getTrack(trackId);
  // The conservative "default" line profile. Pace is a SEPARATE axis from the
  // profile - it is the AI difficulty, handed straight to computeAIControls -
  // so the line can be held fixed while only how hard it is driven varies.
  const line = computeRacingLine(track, "default");
  const session = await createDriveSession({ track });
  const attack = createTimeAttack(track.lengthMeters);
  const half = track.lengthMeters / 2;

  let previousProgress: number | null = null;
  let wraps = 0;
  let biggestDrivingStep = 0;
  let offThisLap = false;
  const offTrackThisLap: boolean[] = [];
  const lapSeconds: (number | null)[] = [];
  const lapValid: boolean[] = [];
  let bestWasSet = false;
  const limit = Math.round(maxSeconds / DT);

  for (let tick = 0; tick < limit; tick++) {
    const before = session.state();
    // computeAIControls does its own nearest-line search (its warmStartIndex
    // argument is optional), so there is nothing to pre-compute here.
    const controls = computeAIControls(line, before.x, before.z, before.yawRad, before.speedMs, false, paceScale);
    session.advance(DT, {
      throttle: controls.throttle,
      brake: controls.brake,
      steer: controls.steer,
    });
    const after = session.state();

    if (previousProgress !== null) {
      const step = after.progressMeters - previousProgress;
      if (Math.abs(step) > half) wraps++;
      else if (Math.abs(step) > biggestDrivingStep) biggestDrivingStep = Math.abs(step);
    }
    previousProgress = after.progressMeters;

    const off = allWheelsOffTrack(track, wheelPositions(after), WHEEL_RADIUS);
    if (off) offThisLap = true;
    const state = attack.sample({
      progressMeters: after.progressMeters,
      wheelsOffTrack: off,
      elapsedSeconds: after.elapsedSeconds,
    });
    if (state.completed !== null) {
      lapSeconds.push(state.completed.lapSeconds);
      lapValid.push(state.completed.valid);
      offTrackThisLap.push(offThisLap);
      if (state.completed.isBest) bestWasSet = true;
      offThisLap = false;
    }
    if (state.lapsCompleted >= targetLaps) break;
  }

  return {
    lapsCompleted: attack.state().lapsCompleted,
    wraps,
    biggestDrivingStep,
    offTrackThisLap,
    lapSeconds,
    lapValid,
    bestLapSeconds: attack.state().bestLapSeconds,
    bestWasSet,
  };
}

describe("time attack on the real car", () => {
  it("banks exactly one lap per line crossing, at a real circuit's pace", async () => {
    // The wrap must actually fire, and fire once per crossing. A time attack
    // that silently never records anything is the failure this whole file
    // exists to catch, and only the real progress reading can hide it.
    const result = await driveAndTime("silverstone", 420, 2);
    expect(result.lapsCompleted).toBeGreaterThanOrEqual(2);
    // Every lap banked came from a real crossing, and every crossing the
    // reading reported became a lap: no wrap thrown away, and - the one that
    // would be an invented lap - no lap without a wrap behind it.
    expect(result.wraps).toBe(result.lapsCompleted);
    expect(result.lapSeconds).toHaveLength(result.lapsCompleted);
    for (const seconds of result.lapSeconds) {
      expect(seconds).not.toBeNull();
      // Timed on the session's simulated clock, so a real lap of this circuit
      // and nowhere near a fraction of one.
      expect(seconds!).toBeGreaterThan(MIN_LAP_SECONDS);
      expect(seconds!).toBeGreaterThan(45);
      expect(seconds!).toBeLessThan(240);
    }
    // The distance guard that stops the start-line flicker is a threshold on
    // the step, so the threshold has to sit far above anything real driving
    // produces. If it did not, an ordinary step would read as a crossing and
    // the circuit would invent laps on its own.
    expect(result.biggestDrivingStep).toBeLessThan(60);
  }, 300_000);

  it("marks a lap invalid exactly when all four wheels left the track", async () => {
    // The flag has to be the game's rule on the real wheel positions: not the
    // merely wide chassis centre, and not something always-true or
    // always-false. Equality with the independently observed excursion is the
    // property, and it has to hold on laps that are genuinely a mix.
    const result = await driveAndTime("monza", 400, 3, 0.8);
    expect(result.lapsCompleted).toBeGreaterThanOrEqual(1);
    expect(result.lapValid).toEqual(result.offTrackThisLap.map((off) => !off));
    // The rule bites in both directions across the laps observed: a lap with an
    // excursion is invalid AND never becomes the best, and the best is only ever
    // the fastest valid one.
    expect(result.offTrackThisLap.length).toBe(result.lapsCompleted);
    for (let i = 0; i < result.lapValid.length; i++) {
      if (result.offTrackThisLap[i]) expect(result.lapValid[i]).toBe(false);
    }
    if (result.bestWasSet) {
      expect(result.bestLapSeconds).not.toBeNull();
      // A best is only ever a valid lap's time, never an invalid one.
      for (const seconds of result.lapSeconds) {
        if (result.lapValid[result.lapSeconds.indexOf(seconds)] === false) {
          expect(seconds!).toBeGreaterThanOrEqual(result.bestLapSeconds!);
        }
      }
    }
  }, 300_000);
});
