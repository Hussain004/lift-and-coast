import { describe, expect, it } from "vitest";
import { createDriveSession, type DriveSession } from "../lib/ai/driveSession";
import { getTrack } from "../lib/tracks/trackData";

/**
 * The landing-page time attack drives a car through this session, and a
 * lap-time leaderboard is only meaningful if the lap is timed on the same
 * physics as a race lap. So these tests care about two things: that the car is
 * genuinely driven by the shared control path, and that a lap's simulated time
 * is independent of how the browser happened to slice its frames.
 */

const TRACK_ID = "silverstone";
const FULL_THROTTLE = { throttle: 1, brake: 0, steer: 0 };

/** Runs the session for `seconds` of simulated time, one 1/60 tick at a time. */
function drive(session: DriveSession, seconds: number, input = FULL_THROTTLE): void {
  const ticks = Math.round(seconds * 60);
  for (let i = 0; i < ticks; i++) session.advance(1 / 60, input);
}

describe("drive session", () => {
  it("drives the car forward under throttle", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    const start = session.state();
    drive(session, 3);
    const end = session.state();

    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    expect(distance).toBeGreaterThan(20);
    expect(end.speedMs).toBeGreaterThan(5);
    expect(end.elapsedSeconds).toBeCloseTo(3, 3);
  });

  it("starts on the track's own start position, facing its own heading", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    const state = session.state();
    expect(state.x).toBeCloseTo(track.startPos.x, 3);
    expect(state.z).toBeCloseTo(track.startPos.z, 3);
    // Not moving yet.
    expect(state.speedMs).toBe(0);
    expect(state.offTrackMeters).toBe(0);
  });

  it("climbs gears under sustained power", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    // Sampled over six seconds, while the car is still on the road: a
    // full-throttle run with no steering eventually drives straight off the
    // circuit and parks against the scenery, so the gear at the END of a long
    // run says nothing about the gearbox.
    let peakGear = 1;
    for (let i = 0; i < 6 * 60; i++) {
      session.advance(1 / 60, FULL_THROTTLE);
      peakGear = Math.max(peakGear, session.state().gear);
    }
    // The auto gearbox is the shared one, so a flat-out run has to work up
    // through the ratios rather than sitting on the limiter in first.
    expect(peakGear).toBeGreaterThan(1);
    expect(session.state().rpm).toBeGreaterThan(0);
  });

  it("stops under braking", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track, speedMs: 40 });
    expect(session.state().speedMs).toBeGreaterThan(20);
    drive(session, 4, { throttle: 0, brake: 1, steer: 0 });
    expect(session.state().speedMs).toBeLessThan(20);
  });

  it("is frame-rate independent: the same simulated time covers the same ground", async () => {
    const track = getTrack(TRACK_ID);
    // One long frame per tick (exactly the tick rate) versus a browser that
    // hands over big chunks and a slow one that dribbles them in. The lap time
    // must not depend on which.
    const steady = await createDriveSession({ track });
    for (let i = 0; i < 300; i++) steady.advance(1 / 60, FULL_THROTTLE);
    const steadyState = steady.state();

    const chunky = await createDriveSession({ track });
    for (let i = 0; i < 20; i++) chunky.advance(0.25, FULL_THROTTLE);
    const chunkyState = chunky.state();

    const dribble = await createDriveSession({ track });
    for (let i = 0; i < 900; i++) dribble.advance(1 / 180, FULL_THROTTLE);
    const dribbleState = dribble.state();

    const position = (s: { x: number; z: number }) => `${s.x.toFixed(2)},${s.z.toFixed(2)}`;
    expect(position(chunkyState)).toBe(position(steadyState));
    expect(position(dribbleState)).toBe(position(steadyState));
    expect(chunkyState.gear).toBe(steadyState.gear);
    expect(dribbleState.elapsedSeconds).toBeCloseTo(steadyState.elapsedSeconds, 6);
  });

  it("caps catch-up ticks so a backgrounded tab cannot run away", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    // A 10 second stall must clamp to the 0.5s allowance (30 ticks), not try
    // to simulate 600 steps in one frame and lock the tab up.
    expect(session.advance(10, FULL_THROTTLE)).toBeLessThanOrEqual(30);
    // ...and a chunky-but-legitimate frame is NOT truncated, or the lap time
    // would depend on the browser's frame pacing.
    expect(session.advance(0.25, FULL_THROTTLE)).toBe(15);
  });

  it("resets position, velocity, gear and the clock", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    drive(session, 5);
    expect(session.state().elapsedSeconds).toBeGreaterThan(4);
    session.reset();
    const state = session.state();
    expect(state.elapsedSeconds).toBe(0);
    expect(state.speedMs).toBe(0);
    expect(state.gear).toBe(1);
    expect(state.x).toBeCloseTo(track.startPos.x, 3);
    expect(state.z).toBeCloseTo(track.startPos.z, 3);
  });

  it("reports progress along the lap, wrapping at the start line", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track });
    const start = session.state();
    expect(start.progressMeters).toBeLessThan(50);
    drive(session, 6);
    const state = session.state();
    expect(state.progressMeters).toBeGreaterThanOrEqual(0);
    expect(state.progressMeters).toBeLessThan(track.lengthMeters);
  });

  it("applies a grip multiplier that actually changes the car", async () => {
    const track = getTrack(TRACK_ID);
    // Braking, not acceleration: a flat-out straight line with traction
    // control on is engine- and drag-limited, so it cannot show a grip
    // difference at all. Braking is genuinely tyre-limited, which is what
    // makes this a real test that the multiplier reaches the friction model.
    const stopFrom = async (grip: number) => {
      const session = await createDriveSession({ track, gripMultiplier: grip, speedMs: 45 });
      let ticks = 0;
      while (session.state().speedMs > 5 && ticks < 60 * 10) {
        session.advance(1 / 60, { throttle: 0, brake: 1, steer: 0 });
        ticks++;
      }
      return ticks;
    };
    const dryTicks = await stopFrom(1);
    const wetTicks = await stopFrom(0.6);
    // Less grip must take longer to stop, or the multiplier is decorative.
    expect(wetTicks).toBeGreaterThan(dryTicks);
  });

  it("steers", async () => {
    const track = getTrack(TRACK_ID);
    const session = await createDriveSession({ track, speedMs: 30 });
    drive(session, 0.5, { throttle: 0.5, brake: 0, steer: 0 });
    const straight = session.state().yawRad;
    const other = await createDriveSession({ track, speedMs: 30 });
    drive(other, 0.5, { throttle: 0.5, brake: 0, steer: 1 });
    const turned = other.state().yawRad;
    expect(Math.abs(turned - straight)).toBeGreaterThan(0.05);
  });
});
