import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMISSION_GATE,
  createSubmissionGate,
  createTimeAttack,
  driverCodeFromName,
  loadTimeAttackName,
  saveTimeAttackName,
} from "../lib/race/timeAttack";
import { MIN_LAP_SECONDS } from "../lib/race/lapTimer";

/**
 * The time attack's lap logic decides what a lap-time leaderboard accepts, so
 * these tests care about one thing above all: a lap is only ever banked when a
 * car genuinely drove round the circuit. Nearly every test below is an attempt
 * to bank one WITHOUT driving one.
 */

// A lap of this length is driven in 40s, which is 2.5m per 1/60s tick.
const LAP_METERS = 6000;
const DT = 1 / 60;
const LAP_SECONDS = 40;

/**
 * A stand-in for the drive session: holds the simulated clock and the car's
 * place on the lap and advances both one tick at a time. It mirrors the
 * contract driveSession offers - elapsedSeconds only moves forward in DT
 * steps unless a caller teleports the car - so a lap driven through here is
 * timed exactly as it would be in the browser.
 */
function fakeSession(lapMeters = LAP_METERS) {
  const attack = createTimeAttack(lapMeters);
  return {
    attack,
    elapsed: 0,
    progress: 0,
    wheelsOffTrack: false,
    /** One tick of forward motion, at the speed implied by `lapSeconds`. */
    tick(lapSeconds: number, atProgress?: number) {
      this.progress = (atProgress ?? this.progress) + lapMeters / (lapSeconds * 60);
      if (this.progress >= lapMeters) this.progress -= lapMeters;
      this.elapsed += DT;
      return this.sample();
    },
    sample() {
      return attack.sample({
        progressMeters: this.progress,
        wheelsOffTrack: this.wheelsOffTrack,
        elapsedSeconds: this.elapsed,
      });
    },
    /** Jump straight to a point on the lap, as a teleport or a scrub would. */
    warp(progress: number, elapsed: number) {
      this.progress = progress;
      this.elapsed = elapsed;
      return this.sample();
    },
  };
}

type Session = ReturnType<typeof fakeSession>;
type State = ReturnType<ReturnType<typeof createTimeAttack>["state"]>;

/** Drives `lapSeconds` of forward progress, returning the resulting state. */
function driveLap(session: Session, lapSeconds: number): State {
  const ticks = Math.round(lapSeconds / DT);
  let state = session.attack.state();
  for (let i = 0; i < ticks; i++) state = session.tick(lapSeconds);
  return state;
}

describe("lap detection", () => {
  it("banks a lap after a full lap at speed", () => {
    const session = fakeSession();
    const state = driveLap(session, LAP_SECONDS);
    expect(state.lapsCompleted).toBe(1);
    expect(state.lastLapSeconds).toBeCloseTo(LAP_SECONDS, 1);
    expect(state.lastLapValid).toBe(true);
    expect(state.completed?.isBest).toBe(true);
    // And the next lap starts clean, at zero on the clock.
    expect(state.currentLapSeconds).toBeCloseTo(0, 3);
    expect(state.invalid).toBe(false);
  });

  it("keeps driving laps and keeps the best", () => {
    const session = fakeSession();
    driveLap(session, 40);
    const slower = driveLap(session, 45);
    expect(slower.lapsCompleted).toBe(2);
    expect(slower.lastLapSeconds).toBeCloseTo(45, 1);
    // A slower lap is still a completed lap, just not a personal best.
    expect(slower.lastLapValid).toBe(true);
    expect(slower.completed?.isBest).toBe(false);
    expect(slower.bestLapSeconds).toBeCloseTo(40, 1);

    const faster = driveLap(session, 38);
    expect(faster.completed?.isBest).toBe(true);
    expect(faster.bestLapSeconds).toBeCloseTo(38, 1);
  });

  it("does not bank a lap for a car parked on the start line", () => {
    const session = fakeSession();
    // checkTrackLimits' seam flicker, exactly as documented in
    // progressTracker.ts: a stationary car sitting on the line reads progress
    // ~0 on one tick and ~trackLength on the next, because the first and last
    // centerline points are metres apart in space. With a naive "progress went
    // down, so a lap" rule this banks a lap every other frame.
    for (let i = 1; i <= 200; i++) {
      const state = session.warp(i % 2 === 0 ? LAP_METERS - 1 : 1, i * DT);
      expect(state.lapsCompleted).toBe(0);
      expect(state.lastLapSeconds).toBeNull();
    }
  });

  it("does not bank a lap for shuffling back and forth over the line", () => {
    const session = fakeSession();
    // Ten seconds of the car crossing the line, reversing and crossing again,
    // never getting more than 60m from it. On the ribbon the whole time.
    for (let i = 0; i < 10 / DT; i++) {
      const back = Math.floor(i / 60) % 2 === 1;
      const at = back ? LAP_METERS - 50 + (i % 60) * 0.5 : 50 - (i % 60) * 0.5;
      const state = session.warp(at, (i + 1) * DT);
      expect(state.lapsCompleted).toBe(0);
    }
  });

  it("does not bank a lap for driving 30% of the lap and reversing to the line", () => {
    const session = fakeSession();
    // Out to 30% of the lap over 40s, then back to the line over another 40s,
    // then forwards over it again - the last frame being the one that would
    // bank the reversal as a "lap".
    for (let i = 0; i < 40 / DT; i++) {
      const at = Math.min(LAP_METERS * 0.3, ((i + 1) * LAP_METERS) / (40 * 60));
      expect(session.warp(at, (i + 1) * DT).lapsCompleted).toBe(0);
    }
    for (let i = 0; i < 40 / DT; i++) {
      const at = Math.max(0, LAP_METERS * 0.3 - ((i + 1) * LAP_METERS) / (40 * 60));
      expect(session.warp(at, 40 + (i + 1) * DT).lapsCompleted).toBe(0);
    }
    expect(session.warp(1, 80 + DT).lapsCompleted).toBe(0);
  });

  it("does not bank a lap for reversing over the line mid-lap", () => {
    const session = fakeSession();
    // Out to 58% of the lap over 35s, then back across the start line over
    // 30s. The car covers a genuine distance in both directions, so only the
    // direction of the crossing can be judged.
    const outTicks = Math.round(35 / DT);
    for (let i = 0; i < outTicks; i++) {
      const at = ((i + 1) * (LAP_METERS * 0.58)) / outTicks;
      expect(session.warp(at, (i + 1) * DT).lapsCompleted).toBe(0);
    }
    const backTicks = Math.round(30 / DT);
    for (let i = 0; i < backTicks; i++) {
      const at = LAP_METERS * 0.58 - ((i + 1) * (LAP_METERS * 0.58)) / backTicks;
      expect(session.warp(at, 35 + (i + 1) * DT).lapsCompleted).toBe(0);
    }
  });

  it("does not bank a lap that covers the distance in an implausible time", () => {
    // The distance is covered honestly in 38s, then the remaining 10% of the
    // lap is covered in 2s and the line is crossed - a 40s lap whose last 10%
    // was impossible. MIN_LAP_SECONDS is the guard that catches it.
    const session = fakeSession();
    driveLap(session, 40);
    expect(session.attack.state().lapsCompleted).toBe(1);

    // A fresh attempt: 60% of the lap in 2 seconds, then over the line.
    const fast = fakeSession();
    const ticks = Math.round(2 / DT);
    for (let i = 0; i < ticks; i++) fast.tick(4);
    const state = fast.warp(0, fast.elapsed + DT);
    expect(state.lapsCompleted).toBe(0);
  });

  it("uses the race's own minimum lap time, not a private one", () => {
    // If the race ever changes its minimum, the time attack must follow rather
    // than silently disagreeing with it about what a lap is.
    const session = fakeSession();
    const lapSeconds = MIN_LAP_SECONDS - 5;
    driveLap(session, lapSeconds);
    expect(session.attack.state().lapsCompleted).toBe(0);
  });

  it("reports no laps at all for a degenerate track length", () => {
    for (const length of [0, -1, Number.NaN]) {
      const session = fakeSession(length);
      for (let i = 0; i < 40 / DT; i++) {
        session.tick(40);
        expect(session.attack.state().lapsCompleted).toBe(0);
        expect(session.attack.state().bestLapSeconds).toBeNull();
      }
    }
  });

  it("reads the lap clock off the session's simulated time, not wall-clock", () => {
    const session = fakeSession();
    session.warp(0, 0);
    const state = session.warp(100, 12.5);
    expect(state.currentLapSeconds).toBeCloseTo(12.5, 6);
  });

  it("reports a null best until a valid lap is actually banked", () => {
    const session = fakeSession();
    expect(session.attack.state().bestLapSeconds).toBeNull();
    driveLap(session, LAP_SECONDS);
    expect(session.attack.state().bestLapSeconds).toBeGreaterThan(0);
  });

  it("does not count the very first sample as forward motion", () => {
    // A car on the grid genuinely can read a long way round the lap, if its
    // circuit's start line is not at the projection origin. Seeding the lap
    // with that reading as "distance already covered" would let a stationary
    // car bank a lap on its first crossing.
    const session = fakeSession();
    session.warp(500, 0);
    expect(session.attack.state().currentLapSeconds).toBeCloseTo(0, 6);
    expect(session.attack.state().lapsCompleted).toBe(0);
  });
});

describe("track limits", () => {
  it("invalidates a lap that put all four wheels off, and keeps the flag", () => {
    const session = fakeSession();
    let state = session.attack.state();
    // One frame off the track early in the lap, straight back on after. The
    // flag has to LATCH: a single excursion ruins the lap even though the car
    // is on the ribbon again by the next frame.
    for (let i = 0; i < 38 / DT; i++) {
      session.wheelsOffTrack = i === 200;
      state = session.tick(LAP_SECONDS);
      if (i > 200) expect(state.invalid).toBe(true);
    }
    state = session.warp(0, session.elapsed + DT);
    expect(state.lapsCompleted).toBe(1);
    expect(state.lastLapValid).toBe(false);
    // An invalid lap must never become the bar the next lap has to clear, and
    // must never be submittable.
    expect(state.bestLapSeconds).toBeNull();
    expect(state.completed?.isBest).toBe(false);
  });

  it("keeps a lap whose wheels only clipped the edge", () => {
    // The caller passes allWheelsOffTrack, so a car that never had all four
    // wheels off arrives with the flag false and is scored normally - which is
    // what makes a wide corner exit legal rather than a self-inflicted foul.
    const session = fakeSession();
    const state = driveLap(session, LAP_SECONDS);
    expect(state.lastLapValid).toBe(true);
  });

  it("still invalidates a lap whose very first frame is off track", () => {
    const session = fakeSession();
    session.wheelsOffTrack = true;
    const state = session.warp(10, 0);
    expect(state.invalid).toBe(true);
  });

  it("clears the invalid flag when the next lap starts", () => {
    const session = fakeSession();
    // Off the track for 38s of the lap, then back on the ribbon for the run to
    // the line - the excursion belongs to the lap it happened in, not the next.
    session.wheelsOffTrack = true;
    for (let i = 0; i < 38 / DT; i++) session.tick(LAP_SECONDS);
    session.wheelsOffTrack = false;
    expect(session.warp(0, session.elapsed + DT).lastLapValid).toBe(false);

    const next = driveLap(session, LAP_SECONDS);
    expect(next.lastLapValid).toBe(true);
    expect(next.invalid).toBe(false);
  });

  it("counts an excursion on the finishing frame against the lap it ends", () => {
    // The car crosses the line with all four wheels off. The flag latches
    // before the wrap is judged, so the lap that just ended is the one that
    // pays for it - and the next lap is not tainted by a frame that belongs to
    // the previous one.
    const session = fakeSession();
    for (let i = 0; i < 38 / DT; i++) session.tick(LAP_SECONDS);
    session.wheelsOffTrack = true;
    expect(session.warp(0, session.elapsed + DT).lastLapValid).toBe(false);
    session.wheelsOffTrack = false;
    expect(driveLap(session, LAP_SECONDS).lastLapValid).toBe(true);
  });
});

describe("teleports and resets", () => {
  it("abandons the running lap when the session teleports the car to the grid", () => {
    const session = fakeSession();
    // Out to 58% of the lap, then the OFF_TRACK_RESET_METERS backstop teleports
    // the car to the grid and zeroes the clock. Read naively, that is a wrap
    // backwards through the start line after a plausible-looking distance, and
    // the distance guard would wave it through.
    const outTicks = Math.round(35 / DT);
    for (let i = 0; i < outTicks; i++) {
      session.warp(((i + 1) * (LAP_METERS * 0.58)) / outTicks, (i + 1) * DT);
    }
    session.wheelsOffTrack = true;
    const state = session.warp(0, 0);
    // No lap is scored, and none is recorded as aborted either: the attempt
    // simply stops existing.
    expect(state.lapsCompleted).toBe(0);
    expect(state.lastLapSeconds).toBeNull();
    expect(state.currentLapSeconds).toBeCloseTo(0, 6);
    // And the next lap from the grid is a fresh one, not a penalised one -
    // it must be able to be valid, or a single excursion would cost the driver
    // every lap after it.
    session.wheelsOffTrack = false;
    expect(driveLap(session, LAP_SECONDS).lastLapValid).toBe(true);
  });

  it("abandons the running lap on reset but keeps the best", () => {
    const session = fakeSession();
    driveLap(session, LAP_SECONDS);
    expect(session.attack.state().bestLapSeconds).toBeCloseTo(LAP_SECONDS, 1);

    for (let i = 0; i < 200; i++) session.tick(LAP_SECONDS);
    const after = session.attack.reset(session.elapsed);
    // The personal best survives: chasing it is the whole point, and wiping it
    // on every reset would leave the delta timer nothing to compare against.
    expect(after.bestLapSeconds).toBeCloseTo(LAP_SECONDS, 1);
    expect(after.lapsCompleted).toBe(1);
    expect(after.currentLapSeconds).toBeCloseTo(0, 6);
    expect(after.invalid).toBe(false);
  });

  it("does not bank the aborted lap when the car drives on after a reset", () => {
    const session = fakeSession();
    driveLap(session, LAP_SECONDS);
    for (let i = 0; i < 200; i++) session.tick(LAP_SECONDS);
    session.attack.reset(session.elapsed);
    // The distance the aborted attempt covered is discarded, so crossing the
    // line again straight away is not a lap.
    const state = session.warp(0, session.elapsed + DT);
    expect(state.lapsCompleted).toBe(1);
  });
});

describe("submission gate", () => {
  it("allows the first submission and then enforces the quiet period", () => {
    const gate = createSubmissionGate();
    expect(gate.tryConsume(1000)).toBe(true);
    // A hot loop calling this every frame for the next 20 seconds is refused.
    for (let ms = 1016; ms < 1000 + DEFAULT_SUBMISSION_GATE.minIntervalMs; ms += 16) {
      expect(gate.tryConsume(ms)).toBe(false);
    }
    // ...and allowed again once the period has passed, so a real player who
    // sets a second, better lap is never gated.
    expect(gate.tryConsume(1000 + DEFAULT_SUBMISSION_GATE.minIntervalMs)).toBe(true);
  });

  it("caps submissions inside the rolling window", () => {
    const gate = createSubmissionGate({ minIntervalMs: 100, windowMs: 1000, maxInWindow: 3 });
    expect(gate.tryConsume(0)).toBe(true);
    expect(gate.tryConsume(200)).toBe(true);
    expect(gate.tryConsume(400)).toBe(true);
    expect(gate.tryConsume(600)).toBe(false);
    expect(gate.consumed()).toBe(3);
    // Old entries age out, so the cap is a rate limit and not a permanent ban.
    expect(gate.tryConsume(1500)).toBe(true);
    expect(gate.consumed()).toBe(1);
  });

  it("honours custom limits", () => {
    const gate = createSubmissionGate({ minIntervalMs: 0, windowMs: 100, maxInWindow: 1 });
    expect(gate.tryConsume(0)).toBe(true);
    expect(gate.tryConsume(1)).toBe(false);
    expect(gate.tryConsume(500)).toBe(true);
  });

  it("rejects a non-finite or backwards clock rather than opening the gate", () => {
    const gate = createSubmissionGate({ minIntervalMs: 1000 });
    expect(gate.tryConsume(5000)).toBe(true);
    // A rewound Performance.now() must throttle submissions, never accelerate
    // them, so these are refused rather than read as a fresh window.
    expect(gate.tryConsume(Number.NaN)).toBe(false);
    expect(gate.tryConsume(0)).toBe(false);
    expect(gate.consumed()).toBe(1);
  });

  it("resets back to a full gate", () => {
    const gate = createSubmissionGate({ minIntervalMs: 10_000 });
    expect(gate.tryConsume(0)).toBe(true);
    expect(gate.tryConsume(100)).toBe(false);
    gate.reset();
    expect(gate.consumed()).toBe(0);
    expect(gate.tryConsume(100)).toBe(true);
  });
});

describe("driverCodeFromName", () => {
  it("reduces a typed name to a legal driver code", () => {
    expect(driverCodeFromName("Max")).toBe("MAX");
    expect(driverCodeFromName("hussain")).toBe("HUS");
    expect(driverCodeFromName("Lando Norris")).toBe("LAN");
    expect(driverCodeFromName("  a b  ")).toBe("AB");
    // Digits are legal in the column and kept.
    expect(driverCodeFromName("player 1")).toBe("PLA");
  });

  it("returns null rather than inventing a code it cannot justify", () => {
    // A one-character or empty name cannot fill a 2-4 character CHECK, and a
    // fabricated code would be a lie on a public board.
    expect(driverCodeFromName("")).toBeNull();
    expect(driverCodeFromName("a")).toBeNull();
    expect(driverCodeFromName("   ")).toBeNull();
    expect(driverCodeFromName("!@#$")).toBeNull();
  });

  it("always produces a code the board will accept", () => {
    for (const name of ["Al", "Alonso", "x y", "999", "a-b-c-d-e-f"]) {
      const code = driverCodeFromName(name);
      if (code === null) continue;
      expect(code.length).toBeGreaterThanOrEqual(2);
      expect(code.length).toBeLessThanOrEqual(4);
      expect(code).toBe(code.toUpperCase());
    }
  });
});

describe("name storage", () => {
  function memoryStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
  }

  it("round-trips the name", () => {
    const storage = memoryStorage();
    expect(loadTimeAttackName(storage)).toBeNull();
    saveTimeAttackName("HUS", storage);
    expect(loadTimeAttackName(storage)).toBe("HUS");
  });

  it("returns null with no storage at all", () => {
    expect(loadTimeAttackName(null)).toBeNull();
    // Saving with no storage is a no-op, not a throw.
    expect(() => saveTimeAttackName("HUS", null)).not.toThrow();
  });

  it("survives a storage that throws, as private browsing does", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadTimeAttackName(hostile)).toBeNull();
    // The lap still counts and the board still works; only the convenience of
    // remembering the name is lost.
    expect(() => saveTimeAttackName("HUS", hostile)).not.toThrow();
  });

  it("ignores a stored empty string", () => {
    const storage = memoryStorage({ "lift-and-coast.time-attack-name.v1": "" });
    expect(loadTimeAttackName(storage)).toBeNull();
  });
});
