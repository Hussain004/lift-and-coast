"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";
import { useSessionTrackId } from "@/lib/race/sessionSetup";
import { getTrackName, TRACKS } from "@/lib/tracks/registry";
import { getOutline } from "@/lib/tracks/preview";
import { formatLapTime, resolveClientId } from "@/lib/race/leaderboard";
import {
  leaderboardIsConfigured,
  submitLapFromEnv,
} from "@/lib/race/leaderboardClient";
import {
  createSubmissionGate,
  createTimeAttack,
  driverCodeFromName,
  loadTimeAttackName,
  saveTimeAttackName,
  type CompletedLap,
  type TimeAttack,
} from "@/lib/race/timeAttack";
import { createDeltaTracker, formatDelta } from "@/lib/race/deltaTimer";
import { BRAKE_RAMP_SECONDS, stepSteering } from "@/lib/input/steering";
import { loadRosterPrefs } from "@/lib/race/roster";
import {
  carScreenAngle,
  centerlineToPairs,
  createProjection,
  projectToCanvas,
  sampleTrackOutline,
  widestRibbon,
  type TrackProjection,
} from "@/lib/tracks/trackProjection";
import type { SessionInput } from "@/lib/ai/driveSession";
import type { TrackData } from "@/lib/tracks/types";

/**
 * A playable lap on the landing page, next to the circuit's leaderboard.
 *
 * THE CAR IS NOT A SPECIAL ONE. `createDriveSession` (lib/ai/driveSession.ts)
 * is the same physics world on the same `applyCarControls` path the race
 * drives, stepped one tick at a time, so a lap set here is timed on the same
 * car a lap set in a race is. That is the entire reason a time-attack
 * leaderboard is worth having, and it is why nothing in this file implements
 * thrust, brake, steering, grip or drag.
 *
 * Two constraints shaped the whole file, and both are load-bearing:
 *
 *   1. THE LANDING PAGE MUST STAY LIGHT. A drive session needs the circuit's
 *      full centerline (~200KB of JSON; trackData.ts imports all thirty, which
 *      is why lib/tracks/registry.ts keeps geometry out of menu routes) plus
 *      Rapier's WASM, and track limits need lib/physics/vehicle, which imports
 *      three.js. ALL of it is behind dynamic imports that run only when the
 *      player presses "Set a Lap" - including vehicle.ts, so three.js stays out
 *      of this route entirely. Before that, the map is drawn from the ~54KB
 *      stride-sampled outline sidecar the circuit browser already loads, in the
 *      same world coordinates, so it does not jump when the swap happens.
 *   2. THE LEADERBOARD IS BEST-EFFORT, ALWAYS. A submit that fails, times out,
 *      is skipped because the build has no key, or is declined because the
 *      name cannot make a legal code is a line of copy. It never blocks a lap,
 *      never blocks the page, and is never retried in a loop.
 *
 * RENDERING. The per-frame work is split in two on purpose. The circuit is
 * projected ONCE and then only re-stroked: re-projecting 3,000 points at 60fps
 * to draw a background that cannot change is pure waste. The car is
 * re-projected every frame, which is two multiplies. The HUD numbers are
 * written straight into DOM nodes through refs rather than through React
 * state, for the same reason - a setState per frame would re-render this whole
 * block sixty times a second to redraw a clock - and a last-painted cache
 * stops even the textContent writes happening when nothing changed. React
 * state here holds only what moves on a human timescale: the typed name,
 * whether a session exists, and the last completed lap.
 */

const TRACK_IDS: ReadonlySet<string> = new Set(TRACKS.map((t) => t.id));

/** The time attack runs in the fastest conditions the game has: dry and fresh. */
const COMPOUND = "soft";

/** Internal canvas resolution. CSS scales it; the backing store stays square. */
const CANVAS_PX = 420;

/**
 * Cap on the frame delta, matching driveSession's own elapsed-time clamp, so a
 * backgrounded tab can never try to simulate thousands of steps in one frame
 * and so frame pacing here can never make a lap time differ between browsers.
 */
const MAX_FRAME_SECONDS = 0.5;

/** Trail length in samples, i.e. about a second and a half at 60fps. */
const TRAIL_SAMPLES = 90;

const THROTTLE_KEYS = ["KeyW", "ArrowUp"];
const BRAKE_KEYS = ["KeyS", "ArrowDown"];
const LEFT_KEYS = ["KeyA", "ArrowLeft"];
const RIGHT_KEYS = ["KeyD", "ArrowRight"];
/** Keys the page would otherwise scroll with while the player is driving. */
const SCROLL_KEYS = new Set([...THROTTLE_KEYS, ...BRAKE_KEYS, ...LEFT_KEYS, ...RIGHT_KEYS]);

const STEER_RATE = 5;
const STEER_CENTER_RATE = 7;

/** How many characters of the name the board's driver code can be built from. */
const MAX_NAME_LENGTH = 24;

/**
 * Road width to stroke for the lightweight outline, in metres. The real ribbon
 * widths are not in the sidecar, and this only has to keep a street circuit
 * and a fast one both legible, so a typical F1 width is right.
 */
const OUTLINE_ROAD_METERS = 12;

type Phase = "idle" | "loading" | "driving" | "failed";
/** The phases a run can be tagged with; "idle" is what the tag not matching is. */
type ActivePhase = Exclude<Phase, "idle">;

/**
 * A completed personal best, tagged with the circuit it was set on, plus a
 * serial so the submit effect runs once per lap rather than every time it
 * re-renders. The tag is what makes switching circuits safe: the completion
 * stops matching and the block shows none, with no effect writing state to
 * clear it.
 */
interface Completion {
  seq: number;
  trackId: string;
  lap: CompletedLap;
}

export function TimeAttack() {
  const trackId = useSessionTrackId();
  // The remembered name, read through a lazy initialiser rather than in an
  // effect: setState directly in an effect body is what
  // react-hooks/set-state-in-effect bans, and the storage read is guarded for
  // SSR anyway. Same pattern as lib/race/roster.ts and SessionSetup.
  const [name, setName] = useState(() => loadTimeAttackName() ?? "");
  // The run is TAGGED WITH ITS CIRCUIT, and the phase is derived from that tag
  // during render rather than stored separately. That is the TrackRecords
  // lesson applied: choosing a different circuit then cannot leave a frame
  // showing the previous circuit's state, and no effect has to write state to
  // fix it up. Deriving means there is no state to get wrong.
  const [run, setRun] = useState<{ trackId: string; phase: ActivePhase } | null>(null);
  // ONE piece of state for laps, and it is the last COMPLETED lap, never the
  // live one. The live clock changes every frame and goes straight to the DOM.
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [posted, setPosted] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Mutable 60Hz state. Refs, not React state: the session, the lap logic, the
  // input and the map transform are all written every frame.
  const sessionRef = useRef<{
    session: Awaited<ReturnType<typeof import("@/lib/ai/driveSession")["createDriveSession"]>>;
    track: TrackData;
    /** The game's real all-four-wheels rule, plus the wheel layout it needs. */
    allWheelsOffTrack: typeof import("@/lib/tracks/trackLimits")["allWheelsOffTrack"];
    carWheels: typeof import("@/lib/physics/vehicle")["CAR_WHEELS"];
  } | null>(null);
  const attackRef = useRef<TimeAttack | null>(null);
  const deltaRef = useRef(createDeltaTracker());
  const gateRef = useRef(createSubmissionGate());
  /** True between pressing the button and the car being ready. */
  const startingRef = useRef(false);
  /** The highest lap serial already offered to the board: once per lap, ever. */
  const lastSubmittedRef = useRef(0);
  const seqRef = useRef(0);
  const inputRef = useRef<SessionInput>({ throttle: 0, brake: 0, steer: 0 });
  const keysRef = useRef(new Set<string>());
  const touchRef = useRef<TouchState>(createTouchState());
  const frameRef = useRef(0);
  // The typed name, mirrored into a ref from the input's own change handler so
  // the submit effect can read it without listing it as a dependency - typing
  // must never re-fire a submission that has already been made, and reading or
  // writing a ref during render is itself banned.
  const nameRef = useRef(name);

  const mapRef = useRef<{
    projection: TrackProjection;
    path: Path2D;
    roadWidthPx: number;
    /** The start/finish point, and the angle to draw the bar across it. */
    start: { x: number; y: number };
    lineAngle: number;
    /** Which circuit this map belongs to, so a change cannot reuse the old one. */
    trackId: string;
  } | null>(null);
  const hudRef = useRef<{
    current: HTMLElement | null;
    best: HTMLElement | null;
    last: HTMLElement | null;
    delta: HTMLElement | null;
    speed: HTMLElement | null;
  }>({ current: null, best: null, last: null, delta: null, speed: null });
  const paintedRef = useRef<Record<string, string>>({});

  const circuit = getTrackName(trackId);
  const configured = leaderboardIsConfigured();
  // DERIVED, not stored: a run belongs to the circuit it was started on, so
  // picking a different one in the map above simply stops matching and the
  // block is idle again - with no effect writing state to arrange it.
  const phase: Phase = run !== null && run.trackId === trackId ? run.phase : "idle";

  // ------------------------------------------------------------------ paint

  /** Writes to a HUD cell only when the text actually changed. */
  const paint = useCallback((key: string, node: HTMLElement | null, text: string) => {
    if (!node || paintedRef.current[key] === text) return;
    node.textContent = text;
    paintedRef.current[key] = text;
  }, []);

  /**
   * Draws one frame: the circuit (re-projected only when it changed), the
   * start/finish bar, the car's trail so the direction of travel needs no
   * label, and the car itself.
   */
  const draw = useCallback((pose: { x: number; z: number; yawRad: number; offTrack: boolean } | null, trail: { x: number; y: number }[]) => {
    const canvas = canvasRef.current;
    const map = mapRef.current;
    if (!canvas || !map) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { projection, path, roadWidthPx, start, lineAngle } = map;
    const size = canvas.width;

    ctx.clearRect(0, 0, size, size);

    // The ribbon: a wide dark stroke for the road with a brighter hairline on
    // top, so it reads as a road and the line of the circuit stays legible.
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    ctx.lineWidth = roadWidthPx;
    ctx.stroke(path);
    ctx.strokeStyle = "rgba(244, 241, 232, 0.22)";
    ctx.lineWidth = 1.25;
    ctx.stroke(path);

    // Start/finish, drawn across the ribbon at the point the lap logic wraps
    // on. Both the point and the angle come from the centerline rather than the
    // car, so they are computed once with the map.
    ctx.save();
    ctx.translate(start.x, start.y);
    ctx.rotate(lineAngle);
    ctx.fillStyle = "rgba(244, 241, 232, 0.75)";
    ctx.fillRect(-roadWidthPx / 2, -1.5, roadWidthPx, 3);
    ctx.restore();

    if (trail.length > 1) {
      ctx.lineWidth = 2;
      for (let i = 1; i < trail.length; i++) {
        const age = i / trail.length;
        ctx.strokeStyle = `rgba(225, 6, 0, ${(0.05 + age * 0.5).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
        ctx.lineTo(trail[i].x, trail[i].y);
        ctx.stroke();
      }
    }

    if (pose === null) return;
    const car = projectToCanvas(projection, pose.x, pose.z);
    ctx.save();
    ctx.translate(car.x, car.y);
    // The sprite is drawn pointing along +X and turned by the car's own forward
    // vector, so it points where the car is going (see carScreenAngle and its
    // agreement test with the race's minimap).
    ctx.rotate(carScreenAngle(pose.yawRad));
    ctx.fillStyle = pose.offTrack ? "#e10600" : "#f4f1e8";
    ctx.beginPath();
    ctx.moveTo(9, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-3.5, 0);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }, []);

  // ------------------------------------------------------------- map build

  /**
   * Builds the canvas map. The circuit it belongs to is recorded alongside it,
   * because the full centerline only exists once the heavy import has resolved
   * and a later outline build must not quietly overwrite the finer one.
   */
  const buildMap = useCallback(
    (pairs: [number, number][], widthMeters: number, lengthMeters: number, forTrackId: string) => {
      const projection = createProjection(pairs, CANVAS_PX, CANVAS_PX, 0.06, lengthMeters);
      const { points, roadWidthPx } = sampleTrackOutline(pairs, widthMeters, projection);
      const path = new Path2D();
      for (let i = 0; i < points.length; i++) {
        if (i === 0) path.moveTo(points[i].x, points[i].y);
        else path.lineTo(points[i].x, points[i].y);
      }
      path.closePath();
      // The start bar is drawn perpendicular to the circuit's direction of
      // travel at point 0, so it looks right on a circuit that begins
      // mid-straight rather than on a grid straight.
      const nextIndex = Math.min(3, pairs.length - 1);
      const start = projectToCanvas(projection, pairs[0][0], pairs[0][1]);
      const ahead = projectToCanvas(projection, pairs[nextIndex][0], pairs[nextIndex][1]);
      mapRef.current = {
        projection,
        path,
        roadWidthPx,
        start,
        lineAngle: Math.atan2(ahead.y - start.y, ahead.x - start.x) + Math.PI / 2,
        trackId: forTrackId,
      };
    },
    []
  );

  // The light outline, drawn as soon as there is a canvas, so the block is a
  // map from the first paint rather than an empty box waiting on a download.
  // Once the car has loaded, the map is already the full centerline for this
  // circuit and is left alone.
  useEffect(() => {
    if (canvasRef.current === null) return;
    if (mapRef.current !== null && mapRef.current.trackId === trackId) return;
    buildMap(getOutline(trackId).points, OUTLINE_ROAD_METERS, 0, trackId);
    draw(null, []);
  }, [trackId, buildMap, draw]);

  // ------------------------------------------------------------------ loop

  useEffect(() => {
    if (phase !== "driving") return;
    const held = sessionRef.current;
    const attack = attackRef.current;
    if (held === null || attack === null) return;
    const { session, track, allWheelsOffTrack, carWheels } = held;

    const wheelRadius = carWheels[0].radius;
    const trail: { x: number; y: number }[] = [];
    let last = performance.now();

    const frame = () => {
      frameRef.current = requestAnimationFrame(frame);
      const now = performance.now();
      const deltaSeconds = Math.min(MAX_FRAME_SECONDS, Math.max(0, (now - last) / 1000));
      last = now;

      // Input: keyboard and the on-screen pads merged per channel, shaped with
      // the SAME steering ramp and the SAME brake ramp the race uses, so the
      // car handles identically in both places.
      const keys = keysRef.current;
      const touch = touchRef.current;
      const pressed = (list: readonly string[]) => list.some((code) => keys.has(code));
      const steerTarget = (pressed(LEFT_KEYS) ? 1 : 0) - (pressed(RIGHT_KEYS) ? 1 : 0);
      const input = inputRef.current;
      input.steer = touch.steering
        ? touch.steer
        : stepSteering(input.steer, steerTarget, deltaSeconds, STEER_RATE, STEER_CENTER_RATE);
      input.throttle = Math.max(pressed(THROTTLE_KEYS) ? 1 : 0, touch.throttle);
      const brakeTarget = Math.max(pressed(BRAKE_KEYS) ? 1 : 0, touch.brake);
      // The shared anti-flip ramp: releasing stays instant, only the sudden
      // application is shaped, because that is what pitches the chassis over.
      input.brake =
        brakeTarget === 0
          ? 0
          : Math.min(input.brake + deltaSeconds / BRAKE_RAMP_SECONDS, brakeTarget);

      session.advance(deltaSeconds, input);
      const state = session.state();

      // The game's own track-limits rule: all FOUR wheels off, not a merely
      // wide chassis centre, so a single tyre still touching keeps the lap
      // legal and a wide corner exit is never punished.
      const wheelsOffTrack =
        allWheelsOffTrack(track, wheelGroundPositions(state, carWheels), wheelRadius);

      const lap = attack.sample({
        progressMeters: state.progressMeters,
        wheelsOffTrack,
        elapsedSeconds: state.elapsedSeconds,
      });

      if (lap.completed !== null) {
        // endLap BEFORE this frame's sample for the new lap, exactly as
        // deltaTimer documents: it appends the closing sample at the track's
        // true length so the reference's tail interpolates correctly right up
        // to the line. A new personal best becomes the reference other laps
        // compare against.
        deltaRef.current.endLap(lap.completed.lapSeconds, track.lengthMeters, lap.completed.isBest);
        seqRef.current += 1;
        setCompletion({ seq: seqRef.current, trackId: track.id, lap: lap.completed });
      }
      const deltaSecondsVsBest = deltaRef.current.recordSample(state.progressMeters, lap.currentLapSeconds);

      const hud = hudRef.current;
      paint("current", hud.current, formatLapTime(lap.currentLapSeconds * 1000) ?? "--");
      paint("best", hud.best, lap.bestLapSeconds === null ? "--" : formatLapTime(lap.bestLapSeconds * 1000) ?? "--");
      paint(
        "last",
        hud.last,
        lap.lastLapSeconds === null
          ? "--"
          : `${formatLapTime(lap.lastLapSeconds * 1000) ?? "--"}${lap.lastLapValid ? "" : "  INVALID"}`
      );
      paint("delta", hud.delta, formatDelta(deltaSecondsVsBest));
      paint("speed", hud.speed, String(Math.round(Math.abs(state.speedMs) * 3.6)));

      const map = mapRef.current;
      if (map !== null) {
        trail.push(projectToCanvas(map.projection, state.x, state.z));
        if (trail.length > TRAIL_SAMPLES) trail.shift();
      }
      draw(
        { x: state.x, z: state.z, yawRad: state.yawRad, offTrack: state.offTrackMeters > 0 },
        trail
      );
    };

    frameRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(frameRef.current);
  }, [phase, draw, paint]);

  // -------------------------------------------------------------- keyboard

  useEffect(() => {
    if (phase !== "driving") return;
    const isTyping = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (el === null || typeof el.tagName !== "string") return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || el.isContentEditable;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Typing a name must not also drive the car, which is the entire reason
      // this check exists: W A S D are letters.
      if (isTyping(event.target)) return;
      if (!SCROLL_KEYS.has(event.code)) return;
      // Arrows would otherwise scroll the landing page out from under the
      // player mid-corner.
      event.preventDefault();
      keysRef.current.add(event.code);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keysRef.current.delete(event.code);
    };
    // A tab that loses focus with a key held would otherwise leave the
    // throttle stuck on for good.
    const onBlur = () => {
      keysRef.current.clear();
      inputRef.current = { throttle: 0, brake: 0, steer: 0 };
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      onBlur();
    };
  }, [phase]);

  // -------------------------------------------------------------- switching

  // A different circuit must not leave the car driving on the previous one. The
  // loop stops on its own, because the phase is derived from the run's tag and
  // the tag no longer matches - so there is no state to write here, and no
  // frame can show the previous circuit's state. Only the input is dropped, so
  // a key held while picking a new circuit cannot stay down. The session itself
  // is KEPT: at most one is ever alive, it is the player's own car parked where
  // they left it, and coming back to a circuit resumes it rather than silently
  // throwing the car away.
  useEffect(() => {
    inputRef.current = { throttle: 0, brake: 0, steer: 0 };
    keysRef.current.clear();
    touchRef.current.clear();
  }, [trackId]);

  // ------------------------------------------------------------------ start

  const start = useCallback(async () => {
    if (!TRACK_IDS.has(trackId)) return;
    // A session left over from another circuit is a different car on a
    // different map, so it is dropped HERE rather than reused. Without this the
    // block would be stuck: the button would call reset() against a session for
    // a circuit that is no longer selected, and quietly do nothing.
    if (sessionRef.current !== null && sessionRef.current.track.id !== trackId) {
      sessionRef.current = null;
      attackRef.current = null;
    }
    if (sessionRef.current !== null) return;
    // The button is disabled while loading, but a fast double click can still
    // land twice before React re-renders, and two Rapier worlds for one car
    // would be both wasteful and wrong.
    if (startingRef.current) return;
    startingRef.current = true;
    setRun({ trackId, phase: "loading" });
    setPosted(null);
    try {
      // Every heavy import is here, and only here. lib/physics/vehicle is
      // included deliberately: it imports three.js, and importing it at module
      // scope would put three in the landing page's initial bundle.
      const [drive, data, limits, vehicle] = await Promise.all([
        import("@/lib/ai/driveSession"),
        import("@/lib/tracks/trackData"),
        import("@/lib/tracks/trackLimits"),
        import("@/lib/physics/vehicle"),
      ]);
      const track = data.getTrack(trackId);
      // The session owns the car's start position AND heading. Defaulting the
      // heading to 0 parks the car sideways in the pit wall, unable to move,
      // reporting ~0.05 m/s and looking exactly like broken physics.
      const session = await drive.createDriveSession({ track });
      sessionRef.current = {
        session,
        track,
        allWheelsOffTrack: limits.allWheelsOffTrack,
        carWheels: vehicle.CAR_WHEELS,
      };
      attackRef.current = createTimeAttack(track.lengthMeters);
      deltaRef.current = createDeltaTracker();
      gateRef.current.reset();
      // Now the real centerline is available, so redraw at full fidelity. The
      // outline and the centerline share world coordinates, so this does not
      // make the map jump.
      buildMap(centerlineToPairs(track), widestRibbon(track.width), track.lengthMeters, trackId);
      setRun({ trackId, phase: "driving" });
    } catch {
      // Rapier's WASM, an exhausted memory budget, a blocked script: the block
      // says so and the rest of the page is untouched.
      setRun({ trackId, phase: "failed" });
    } finally {
      startingRef.current = false;
    }
  }, [trackId, buildMap]);

  const reset = useCallback(() => {
    const held = sessionRef.current;
    const attack = attackRef.current;
    if (held === null || attack === null) return;
    held.session.reset();
    // The session zeroes its own clock on reset, so the lap logic is told the
    // post-reset time and the abandoned lap's distance is dropped with it. The
    // best lap deliberately survives - chasing it is the whole point.
    attack.reset(held.session.state().elapsedSeconds);
    deltaRef.current = createDeltaTracker();
    setCompletion(null);
  }, []);

  // -------------------------------------------------------------- submitting

  useEffect(() => {
    if (completion === null || !completion.lap.isBest) return;
    if (completion.trackId !== trackId) return;
    // Exactly once per lap, whatever else re-renders this block in between.
    if (completion.seq <= lastSubmittedRef.current) return;
    lastSubmittedRef.current = completion.seq;
    if (!configured || !TRACK_IDS.has(trackId)) return;
    // The gate is belt and braces on top of that: only strictly-better laps
    // ever reach here, and this stops a hot loop writing a row per frame even
    // if the once-per-lap guard above were ever broken.
    if (!gateRef.current.tryConsume(performance.now())) return;
    const code = driverCodeFromName(nameRef.current);
    // No usable name means no submission and no invented identity: the board
    // only accepts a 2-4 character code, and making one up would be a lie on a
    // public table. The lap still counts locally.
    if (code === null) return;
    let clientId: string | null = null;
    try {
      clientId = resolveClientId(window.localStorage);
    } catch {
      clientId = null;
    }
    if (clientId === null) return;
    // The player's own team from the garage picker above, so the board shows a
    // real team beside the code. Read at submit time rather than subscribed to,
    // because a team change must not re-fire a submission.
    const teamId = loadRosterPrefs().teamId;
    submitLapFromEnv(
      {
        trackId,
        lapMs: Math.round(completion.lap.lapSeconds * 1000),
        driverCode: code,
        teamId,
        compound: COMPOUND,
      },
      clientId,
      TRACK_IDS
    ).then((ok) => {
      if (ok) setPosted(formatLapTime(Math.round(completion.lap.lapSeconds * 1000)) ?? "");
      // A failure costs one line of copy. No retry, no error, no interruption.
    });
  }, [completion, configured, trackId]);

  // ------------------------------------------------------------------ view

  return (
    <div className={styles.timeAttack} data-testid="time-attack">
      <div className={styles.recordsHeader}>
        <span className={styles.recordsEyebrow}>04 &nbsp;TIME ATTACK</span>
        <span className={styles.recordsTrack}>{circuit}</span>
      </div>

      <div className={styles.timeAttackBody}>
        <div className={styles.timeAttackStage}>
          <canvas
            ref={canvasRef}
            width={CANVAS_PX}
            height={CANVAS_PX}
            className={styles.timeAttackCanvas}
            role="img"
            aria-label={`${circuit} layout, with your car on it`}
          />
          <TouchPads phase={phase} touchRef={touchRef} />
        </div>

        <div className={styles.timeAttackPanel}>
          <label className={styles.timeAttackField}>
            <span className={styles.timeAttackLabel}>YOUR NAME</span>
            <input
              className={styles.timeAttackInput}
              type="text"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              placeholder="Optional"
              aria-label="Your name, used for the leaderboard"
              onChange={(e) => {
                setName(e.target.value);
                // Mirrored into a ref from the handler rather than during
                // render, so the submit effect can read the current name
                // without the name becoming one of its dependencies.
                nameRef.current = e.target.value;
                saveTimeAttackName(e.target.value);
              }}
            />
          </label>

          <dl className={styles.timeAttackTimes}>
            <div>
              <dt>CURRENT</dt>
              <dd ref={(node) => { hudRef.current.current = node; }}>--</dd>
            </div>
            <div>
              <dt>BEST</dt>
              <dd ref={(node) => { hudRef.current.best = node; }}>--</dd>
            </div>
            <div>
              <dt>LAST</dt>
              <dd ref={(node) => { hudRef.current.last = node; }}>--</dd>
            </div>
            <div>
              <dt>DELTA</dt>
              <dd className={styles.timeAttackDelta} ref={(node) => { hudRef.current.delta = node; }}>&nbsp;</dd>
            </div>
          </dl>

          <p className={styles.timeAttackSpeed}>
            <span ref={(node) => { hudRef.current.speed = node; }}>0</span> KM/H
          </p>

          {phase === "driving" ? (
            <button type="button" className={styles.timeAttackButton} onClick={reset}>
              Set a Lap
            </button>
          ) : (
            <button
              type="button"
              className={styles.timeAttackButton}
              onClick={start}
              disabled={phase === "loading"}
            >
              {phase === "loading" ? "Warming up…" : phase === "failed" ? "Try again" : "Set a Lap"}
            </button>
          )}

          <p className={styles.recordsNote}>
            {phase === "driving" ? (
              <>WASD or the arrows to drive. Timed on the same car as a race; your best valid lap goes to the board.</>
            ) : phase === "loading" ? (
              <>Loading the car…</>
            ) : phase === "failed" ? (
              <>The car could not start here. Everything else on the page still works.</>
            ) : (
              <>Drive a lap on the selected circuit. Your best valid lap is submitted to the board.</>
            )}
          </p>

          {posted !== null && <p className={styles.timeAttackPosted}>Posted {posted} to the board.</p>}
          {phase === "driving" && !configured && (
            <p className={styles.recordsNote}>Records are unavailable on this build; laps still count.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The four wheels' ground positions, from the session's pose.
 *
 * The same layout and the same yaw convention as wheelGroundPositions in
 * vehicle.ts, which is what the physics samples its per-wheel surfaces from -
 * so the track-limits question is asked of the same four points the car is
 * actually driving on. Only yaw is available here (the session reports tilt but
 * not the full quaternion), so this is the planar projection of those points;
 * against a 0.34m wheel-radius margin and suspension travel of ~0.25m on a
 * 7-18m wide track, the difference is a few centimetres.
 */
function wheelGroundPositions(
  state: { x: number; z: number; yawRad: number },
  carWheels: readonly { position: [number, number, number] }[]
): { x: number; z: number }[] {
  const cos = Math.cos(state.yawRad);
  const sin = Math.sin(state.yawRad);
  return carWheels.map((wheel) => ({
    x: state.x + wheel.position[0] * cos - wheel.position[2] * sin,
    z: state.z + wheel.position[0] * sin + wheel.position[2] * cos,
  }));
}

interface TouchState {
  steer: number;
  throttle: number;
  brake: number;
  steering: boolean;
  /** Which pads are currently held, so releasing one does not cancel another. */
  held: Set<string>;
  clear(): void;
}

/**
 * On-screen controls, because the landing page is used on phones. Pointer
 * events rather than touch events, so a mouse, a pen and a finger all work,
 * with pointer capture so a finger that slides off a pad still releases it.
 *
 * Pads are tracked as a set rather than as four independent booleans, because
 * the realistic phone case is holding a steering pad and a pedal at the same
 * time: releasing the steering pad must not also drop the throttle.
 */
function createTouchState(): TouchState {
  const held = new Set<string>();
  return {
    steer: 0,
    throttle: 0,
    brake: 0,
    steering: false,
    held,
    clear() {
      held.clear();
      this.steer = 0;
      this.throttle = 0;
      this.brake = 0;
      this.steering = false;
    },
  };
}
type Pad = "left" | "right" | "throttle" | "brake";

function TouchPads({
  phase,
  touchRef,
}: {
  phase: Phase;
  touchRef: React.RefObject<TouchState>;
}) {
  /** Recomputes the merged axes from whichever pads are still held. */
  const apply = (touch: TouchState) => {
    // Holding both steering pads centres the wheel, which is what a driver
    // asking for no steering input means.
    touch.steer = (touch.held.has("left") ? 1 : 0) - (touch.held.has("right") ? 1 : 0);
    touch.throttle = touch.held.has("throttle") ? 1 : 0;
    touch.brake = touch.held.has("brake") ? 1 : 0;
    touch.steering = touch.steer !== 0;
  };
  const hold = (pad: Pad, down: boolean) => {
    const touch = touchRef.current;
    if (down) touch.held.add(pad);
    else touch.held.delete(pad);
    apply(touch);
  };
  const button = (label: string, pad: Pad, className: string) => (
    <button
      key={pad}
      type="button"
      className={className}
      disabled={phase !== "driving"}
      aria-label={label}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        hold(pad, true);
      }}
      onPointerUp={() => hold(pad, false)}
      onPointerCancel={() => hold(pad, false)}
      onLostPointerCapture={() => hold(pad, false)}
    >
      {label}
    </button>
  );
  return (
    <div className={styles.timeAttackPads}>
      <div className={styles.timeAttackSteer}>
        {button("◀", "left", styles.timeAttackPad)}
        {button("▶", "right", styles.timeAttackPad)}
      </div>
      <div className={styles.timeAttackPedals}>
        {button("BRAKE", "brake", styles.timeAttackPad)}
        {button("GO", "throttle", styles.timeAttackPadGo)}
      </div>
    </div>
  );
}
