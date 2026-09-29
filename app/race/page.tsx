"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsClient } from "../useIsClient";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import styles from "./race.module.css";
import { getTrack } from "@/lib/tracks/trackData";
import { TRACKS, parseTrackId } from "@/lib/tracks/registry";
import { buildMinimapPath, computeFullMapTransform } from "@/lib/tracks/minimap";
import type { TrackData } from "@/lib/tracks/types";
import { createWeatherPlan, parseWeatherSetting } from "@/lib/physics/weatherForecast";
import type { TelemetrySample } from "@/lib/race/telemetry";
import type { RaceOpsCommand, RaceOpsSnapshot } from "@/lib/race/raceOps";
import { parseRaceLaps, parseTimeOfDay, parseSessionMode, parseQualifyingFormat, parseTimeAttack, parseGridSpot, parseRivals, parseDifficulty, parseSeed, parseCarSetup, MAX_FIELD_SIZE, type SessionMode } from "@/lib/race/sessionSetup";
import { parseChampRound } from "@/lib/race/championship";
import { parseDriverCode, parseTeamId, resolveFieldRoster, resolveNetGridRoster } from "@/lib/race/roster";
import { hashSeed, parseGridOrder, randomSeed, shuffledGridOrder } from "@/lib/race/rosterData";
import { netRoom } from "@/lib/net/peer";
import { isRoomCode } from "@/lib/net/protocol";
import { defaultAudioSnapshot } from "@/lib/audio/raceAudio";
import { RaceAudioRig } from "./RaceAudioRig";
import { Haptics } from "./Haptics";
import { RaceOpsPanel } from "./RaceOpsPanel";
import { TelemetryPanel } from "./TelemetryPanel";
import { ControlSettingsPanel } from "./ControlSettingsPanel";
import { applyControls, loadLocalControls, defaultStorage } from "@/lib/settings/controlStorage";
import { MobileControls } from "./MobileControls";
import { createTouchDriveInput, type TouchDriveInput } from "@/lib/input/touch";
import { createHudSnapshot, type HudSnapshot, type SessionResult } from "@/lib/race/hud";
import { Tower } from "./hud/Tower";
import { Notifications, Timing } from "./hud/Timing";
import { Engineer } from "./hud/Engineer";
import { TrackMap } from "./hud/TrackMap";
import { Mfd } from "./hud/Mfd";
import { Results } from "./hud/Results";
import { PauseMenu } from "./hud/PauseMenu";
import { useHudFrame } from "./hud/useHudFrame";
import hudStyles from "./hud/hud.module.css";

const LOADING_TIPS = [
  "Lift & coast: it's not slow, it's strategic.",
  "Harvest under braking, deploy on the straights - the battery is a lap-long budget.",
  "Trail the brake into the apex: the front tyres grip harder while they are loaded.",
  "Overtake mode arms within a second of the car ahead. Save a burst for the zone.",
  "Low-drag aero is for straights only - leave it open into a corner and the rear lets go.",
  "All four wheels past the white line is a track-limits strike. Three and it's a flag.",
  "Hold R to rewind a mistake. The whole field rewinds with you.",
  "Softs are fast for two laps, hards last ten. Box when the grip number falls away.",
  "Kerbs extend your line, sausage kerbs unsettle the car. Use them, don't jump them.",
  "Penalty seconds are added to your race time - a +5s can cost the position after the flag.",
  "Tab shows the full timing tower. , and . flip the wheel display.",
  "Gravel bogs the car down. Grass is slippery. Neither is faster.",
];

/**
 * The loading screen, now about the circuit you are about to drive: its real
 * outline drawing in, the facts that matter, and a rotating tip. Rendered
 * without a track on the server (the race body is client-only).
 */
function TrackLoadingFallback({ track }: { track: TrackData | null }) {
  const meta = track ? TRACKS.find((t) => t.id === track.id) : undefined;
  const [tip, setTip] = useState(() => (track ? track.id.length * 7 : 0) % LOADING_TIPS.length);
  useEffect(() => {
    const id = window.setInterval(() => setTip((n) => (n + 1) % LOADING_TIPS.length), 4200);
    return () => window.clearInterval(id);
  }, []);
  const outline = track ? { d: buildMinimapPath(track), ...computeFullMapTransform(track, 200, 12) } : null;
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <div className={styles.loadingCard}>
        <div className={styles.loadingHeader}>
          <span>LIFT &amp; COAST</span>
          <span>{meta ? `${(track!.lengthMeters / 1000).toFixed(3)} KM · ${meta.corners} TURNS` : ""}</span>
        </div>
        <div className={styles.loadingCircuit} aria-hidden="true">
          {outline && (
            <svg viewBox="0 0 200 200" role="presentation">
              <g transform={outline.transform}>
                <path className={styles.loadingCircuitGhost} d={outline.d} vectorEffect="non-scaling-stroke" />
                <path d={outline.d} pathLength={1} vectorEffect="non-scaling-stroke" />
              </g>
            </svg>
          )}
        </div>
        <div className={styles.loadingKicker}>LOADING CIRCUIT</div>
        <div className={styles.loadingTitle}>{track?.name ?? "\u00a0"}</div>
        <div className={styles.loadingProgress} aria-hidden="true">
          <span />
        </div>
        <p className={styles.loadingTip} key={tip}>
          {LOADING_TIPS[tip]}
        </p>
      </div>
    </div>
  );
}

const Scene = dynamic(() => import("./Scene").then((mod) => mod.Scene), {
  ssr: false,
  loading: () => null,
});

/**
 * The right-hand HUD column holds exactly one of four panels at a time, so
 * they can never stack on each other or fight the mirror above them. H cycles
 * in this order; 4 jumps straight to telemetry.
 */
type HudSlot = "none" | "telemetry" | "ops" | "settings";

/** H cycles the right-hand panel in this order. */
const HUD_SLOT_ORDER: ReadonlyArray<HudSlot> = ["none", "ops", "telemetry", "settings"];

export default function RacePage() {
  // The race body is never server-rendered: the field seed is drawn at random
  // on first render (see fieldSeed), so a server grid and a client grid would
  // be two different draws and hydration would fail on the tower.
  const isClient = useIsClient();
  return (
    // useSearchParams requires a Suspense boundary for static prerendering
    // (Next.js opts the whole route into client-only rendering below it
    // otherwise) - the fallback is never actually seen in practice, since
    // this whole page is already client-only ("use client" above) and the
    // param read resolves synchronously on first render.
    <Suspense fallback={null}>
      {isClient ? <RaceContent /> : <TrackLoadingFallback track={null} />}
    </Suspense>
  );
}

function RaceContent() {
  const searchParams = useSearchParams();
  const raceLaps = parseRaceLaps(searchParams.get("laps"));
  const qualiFormat = parseQualifyingFormat(searchParams.get("qformat"));
  const rivalCount = parseRivals(searchParams.get("rivals"));
  // Time attack (?ta=1): a qualifying session with no clock. It is forced onto
  // qualifying and the timed format here rather than left to whatever ?mode=
  // says, so the flag cannot be half-applied by a hand-edited or truncated
  // link - the two things it depends on are a qualifying session and a ticking
  // format to suppress, and both are set from the flag alone.
  const timeAttack = parseTimeAttack(searchParams.get("ta"));
  const sessionModeOverride: SessionMode | undefined = timeAttack ? "qualifying" : undefined;
  const format = timeAttack ? "timed" : qualiFormat;
  // Nobody to race: a time attack is the driver against their own best lap, so
  // the field is empty and the qualifying overlay has no rival times to show.
  const timeAttackRivals = 0;
  // AI field character (see lib/ai/personalities.ts): the meeting
  // difficulty tier travels on ?diff=, defaulting to Pro's calibrated
  // fast-line reference. In net rooms the host simulates, so the host's
  // tier sets the field.
  const difficulty = parseDifficulty(searchParams.get("diff"));
  // The player's car build (?rh= ride height, ?at= aero trim). Parsed
  // through the same total validator as every other param here, so a
  // hand-edited or truncated link yields a valid setup rather than a NaN
  // reaching the downforce term. The AI is unaffected - see the scope note
  // in lib/physics/carSetup.ts.
  const carSetup = parseCarSetup(searchParams.get("rh"), searchParams.get("at"));
  // Plan section 16 (online multiplayer): a live room turns this visit
  // into a net session (?room= + ?role= + ?slot=, all set by the lobby's
  // START navigation). The room lives in a module singleton that survives
  // client-side navigation - but NOT a hard refresh, which lands back in
  // solo exactly (same track, same garage, local AI): a refresh must never
  // strand a driver in a half-joined ghost room.
  const roomCode = searchParams.get("room");
  const roleParam = searchParams.get("role");
  const roomState = typeof window === "undefined" ? null : netRoom.getState();
  const netRole: "host" | "guest" | null =
    roomCode !== null &&
    isRoomCode(roomCode) &&
    (roleParam === "host" || roleParam === "guest") &&
    roomState !== null &&
    roomState.code === roomCode &&
    roomState.role === roleParam &&
    roomState.status !== "idle"
      ? roleParam
      : null;
  const netActive = netRole !== null;
  const netSlot = (() => {
    if (!netActive) return null;
    if (netRole === "host") return 0;
    const n = parseInt(searchParams.get("slot") ?? "", 10);
    return Number.isInteger(n) && n >= 1 && n <= MAX_FIELD_SIZE - 1 ? n : null;
  })();
  // A guest slot that doesn't validate degrades to solo rather than
  // spawning two cars in one slot.
  const netValid = !netActive || netSlot !== null;
  const track = getTrack(parseTrackId(searchParams.get("track")));
  const trackName = track.name.toUpperCase();
  // Field seed. The roster (which AI cars you get) and the grid order (who is
  // on pole) both derive from it, so a shared link reproduces the exact
  // session and every fresh Drive click deals a new one. Drawn once by the
  // lazy useState initializer, because a new value on re-render would remount
  // the whole scene - the roster is part of the scene key.
  const [fieldSeed] = useState(() => parseSeed(searchParams.get("seed")) ?? randomSeed());
  // Garage pick from the home screen (see lib/race/roster.ts): the player
  // runs their own team's primary, and every rival runs its own team's
  // primary - a full grid dresses per team, like the real thing. The field
  // is drawn from the roster in shuffled order, so it is not the same eleven
  // cars every time. In net rooms the humans come from the lobby roster
  // (join order = grid order) with the same deterministic AI fill on both
  // sides (see resolveNetGridRoster), seeded from the shared room code so
  // host and guest dress the same grid.
  const { team, driver, rivals: soloRivals } = resolveFieldRoster(
    parseTeamId(searchParams.get("team")),
    parseDriverCode(searchParams.get("driver")),
    // A time attack has no field: the whole point is the driver against their
    // own best lap, and an AI car on track is traffic in a session whose only
    // measure is a clean lap.
    timeAttack ? timeAttackRivals : rivalCount,
    fieldSeed
  );
  const playerSlot = netActive && netSlot !== null ? netSlot : 0;
  const baseRivals = !netActive || !netValid
    ? soloRivals
    : (() => {
        const members = roomState?.members ?? [];
        const humans = members.map((m) => ({
          code: m.driver.code,
          name: m.driver.name,
          teamId: m.driver.teamId,
          color: m.driver.color,
        }));
        const totalCars = rivalCount + 1;
        const fill = resolveNetGridRoster(
          humans.map((h) => h.code),
          Math.max(0, totalCars - humans.length),
          // Both clients hold the room code, so hashing it gives every player
          // in the room the same AI fill while still varying between rooms.
          hashSeed(roomState?.code ?? "lift-and-coast")
        );
        const grid = [...humans, ...fill];
        return grid
          .map((entry, slot) => ({ entry, slot }))
          .filter(({ slot }) => slot !== playerSlot)
          .map(({ entry }) => entry);
      })();
  const sessionMode =
    netActive && netValid ? "race" : (sessionModeOverride ?? parseSessionMode(searchParams.get("mode")));
  const qualifyingSession = sessionMode === "qualifying";
  const champRound = netActive ? null : parseChampRound(searchParams.get("champ"));
  // Random grid for quick races (?seed= from the home Drive link): the
  // whole field - player included - shuffles, so nobody is gifted pole.
  // Explicit grids always win, in this order: a full ?order= board (the
  // qualifying banner), ?grid= (qualifying/championship panels), then
  // ?seed=, then the legacy pole start. Net rooms always use join order.
  // Missing or unparseable values fall through to the next source, so
  // every old link drives exactly as before. Pure over the URL (seeded
  // shuffle), so refreshes and shared links reproduce the same grid.
  // Note gridSeed is deliberately NOT fieldSeed: its null is the "nobody
  // asked for a seed, so leave the legacy pole start alone" signal, while
  // fieldSeed is always populated and only picks the field. When ?seed= is
  // present they are the same number.
  const gridSeed = parseSeed(searchParams.get("seed"));
  const explicitGrid = parseGridSpot(searchParams.get("grid"));
  const fullOrder = (() => {
    if (netActive || champRound !== null) return null;
    const parsed = parseGridOrder(searchParams.get("order"));
    if (parsed === null || parsed.length !== soloRivals.length + 1) return null;
    if (!parsed.includes(driver.code)) return null;
    const fieldCodes = new Set([driver.code, ...soloRivals.map((r) => r.code)]);
    if (!parsed.every((code) => fieldCodes.has(code))) return null;
    return parsed;
  })();
  const randomGrid =
    fullOrder === null &&
    !netActive &&
    gridSeed !== null &&
    explicitGrid === null &&
    champRound === null
      ? shuffledGridOrder(soloRivals.length + 1, gridSeed)
      : null;
  // Index of the player's entry in grid order (0 = pole entry first).
  const playerOrderIndex =
    fullOrder !== null
      ? fullOrder.indexOf(driver.code)
      : (randomGrid?.indexOf(0) ?? 0);
  const playerGridSpot =
    netActive && netValid ? playerSlot + 1 : explicitGrid ?? playerOrderIndex + 1;
  const byCode = new Map(soloRivals.map((r) => [r.code, r]));
  const rivals =
    fullOrder !== null
      ? fullOrder.filter((code) => code !== driver.code).map((code) => byCode.get(code)!)
      : randomGrid === null
        ? baseRivals
        : randomGrid.filter((entry) => entry !== 0).map((entry) => soloRivals[entry - 1]);
  // The live tower is written by Car.tsx, but the first paint must already
  // show the real grid order - especially after a qualifying result or a
  // seeded quick race. `rivals` is field order with the player removed, so
  // reinsert the player at the resolved grid slot for the static fallback.
  const initialTowerRows = [
    {
      code: driver.code,
      name: driver.name,
      number: driver.number,
      teamId: team.id,
      color: team.primaryColor,
      grid: playerGridSpot,
      isPlayer: true,
    },
    ...rivals.map((rival, index) => ({
      code: rival.code,
      name: rival.name,
      number: "number" in rival ? rival.number : null,
      teamId: "teamId" in rival ? rival.teamId : null,
      color: rival.color,
      grid: index < playerGridSpot - 1 ? index + 1 : index + 2,
      isPlayer: false,
    })),
  ].sort((a, b) => a.grid - b.grid);
  const goAtRaw = parseInt(searchParams.get("goAt") ?? "", 10);
  const countdownGoAtMs = Number.isInteger(goAtRaw) ? goAtRaw : 0;
  const timeOfDay = parseTimeOfDay(searchParams.get("tod"));
  const weatherSetting = parseWeatherSetting(searchParams.get("weather"));
  // Changeable weather: a seeded rain timeline (see lib/physics/weatherForecast.ts).
  const weatherPlan = useMemo(
    () => (weatherSetting === "changeable" ? createWeatherPlan(fieldSeed) : null),
    [weatherSetting, fieldSeed]
  );
  const weatherPreset = weatherPlan ? weatherPlan.start : weatherSetting === "changeable" ? "clear" : weatherSetting;
  // One shared mutable HUD snapshot (see lib/race/hud.ts): Car writes it,
  // the widgets in ./hud draw it. Recreated on restart, so a fresh grid never
  // inherits the last session's result or banners.
  const hudRef = useRef<HudSnapshot>(createHudSnapshot(sessionMode, raceLaps));
  // One minimap dot element per rival, written by AICar (world metres).
  const aiMarkerEls = useRef<(SVGCircleElement | null)[]>([]);
  const countdownRef = useRef<HTMLDivElement>(null);
  const countdownValueRef = useRef<HTMLSpanElement>(null);
  const muteRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);

  // Dev builds only: the HUD snapshot on window, so a headless browser test
  // can read the live HUD data and inject a result screen.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    (window as unknown as { __liftHud?: React.RefObject<HudSnapshot> }).__liftHud = hudRef;
  }, []);

  // Apply the player's saved control bindings and steering feel BEFORE the
  // first input is read. useDriveInput resolves keys through the live table
  // rather than a captured constant, so this has to happen at mount rather
  // than on a later tick - otherwise the first moments of a session are
  // driven with the default controls regardless of what the player set.
  useEffect(() => {
    const stored = loadLocalControls(defaultStorage());
    if (stored !== null) applyControls(stored);
  }, []);
  // Shared with the race audio rig (see app/race/RaceAudioRig.tsx): both
  // cars write their latest telemetry here every render frame, and the rig
  // pumps it into the synth voices - plain mutable data, never React state,
  // at audio-unrelated rates.
  const audioRef = useRef(defaultAudioSnapshot());
  const touchInputRef = useRef<TouchDriveInput>(createTouchDriveInput());
  const raceCommandsRef = useRef<RaceOpsCommand[]>([]);
  const raceOpsSnapshotRef = useRef<RaceOpsSnapshot | null>(null);
  // The pause menu. Single-player it also pauses physics; online the race
  // runs on underneath (nobody can stop a shared race).
  const [menuOpen, setMenuOpen] = useState(false);
  // Mirrors only ever draw in the cockpit and helmet cameras (see
  // SideMirrors), so "on" is the right default: the chase views stay clean.
  const [sideMirrorsEnabled, setSideMirrorsEnabled] = useState(true);
  // The optional right-hand panel: Race Ops, live telemetry or control
  // settings, mutually exclusive, closed by default. H cycles, 4 jumps to
  // telemetry.
  const [hudSlot, setHudSlot] = useState<HudSlot>("none");
  const raceOpsOpen = hudSlot === "ops";
  // The telemetry sample lives in a ref the car writes every physics step and
  // the panel reads on its own rAF, so an open overlay costs no React
  // re-renders. The ref is only passed down while the slot is on telemetry,
  // which is also what makes the car's per-step work conditional.
  const telemetryRef = useRef<TelemetrySample | null>(null);
  const telemetryOpen = hudSlot === "telemetry";
  const settingsOpen = hudSlot === "settings";
  const cycleHudSlot = useCallback(() => {
    setHudSlot((current) => HUD_SLOT_ORDER[(HUD_SLOT_ORDER.indexOf(current) + 1) % HUD_SLOT_ORDER.length]);
  }, []);
  const toggleTelemetry = useCallback(() => {
    setHudSlot((current) => (current === "telemetry" ? "none" : "telemetry"));
  }, []);
  const [readySceneKey, setReadySceneKey] = useState<string | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [restartCount, setRestartCount] = useState(0);
  const toggleMenu = useCallback(() => setMenuOpen((value) => !value), []);
  const toggleSideMirrors = useCallback(() => {
    setSideMirrorsEnabled((value) => !value);
  }, []);
  const toggleRaceOps = useCallback(
    () => setHudSlot((current) => (current === "ops" ? "none" : "ops")),
    []
  );
  const restart = () => {
    // A new scene key remounts the whole Scene (Rapier world included) -
    // the same clean slate a reload gives, without re-downloading anything.
    hudRef.current = createHudSnapshot(sessionMode, raceLaps);
    setResult(null);
    setMenuOpen(false);
    setRestartCount((n) => n + 1);
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable) return;
      if (event.code === "Escape") {
        event.preventDefault();
        if (!result) toggleMenu();
        return;
      }
      if (event.code === "KeyN") toggleSideMirrors();
      if (event.code === "KeyH") {
        event.preventDefault();
        cycleHudSlot();
      }
      // Digit 4, not a letter: every one of the 26 letters is already bound
      // and 1-3 are the tyre compounds.
      if (event.code === "Digit4") {
        event.preventDefault();
        toggleTelemetry();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleHudSlot, toggleSideMirrors, toggleTelemetry, toggleMenu, result]);
  const toggleMobileReplay = useCallback(() => {
    raceCommandsRef.current.push({ type: "toggle-replay" });
  }, []);
  const singlePlayer = !netActive;
  // Scene owns several session-scoped refs (qualifying format, player/AI
  // identities, hidden reference times). Keep those inputs in the remount
  // key so a same-sized client navigation cannot reuse stale classification.
  const rosterKey = `${driver.code}/${driver.name}/${team.id}/${rivals.map((rival) => rival.code).join(",")}`;
  const sceneKey = `${track.id}-${raceLaps}-${rivals.length}-${sessionMode}-${format}-${timeAttack ? "ta" : qualiFormat}-${difficulty}-${playerGridSpot}-${weatherSetting}-${timeOfDay}-${champRound ?? "none"}-${fullOrder?.join(",") ?? gridSeed ?? "pole"}-${rosterKey}-${netActive ? `${netRole}-${playerSlot}` : "solo"}-r${restartCount}`;
  const sceneReady = readySceneKey === sceneKey;
  const handleSceneReady = useCallback(() => setReadySceneKey(sceneKey), [sceneKey]);
  const sessionLabel =
    timeAttack
      ? "TIME ATTACK"
      : sessionMode === "race"
        ? `RACE · ${raceLaps} LAPS`
        : sessionMode === "qualifying"
          ? "QUALIFYING"
          : `PRACTICE · ${raceLaps} LAPS`;

  return (
    <div className={styles.wrap}>
      <div className={styles.gameStage}>
        <Scene
          key={sceneKey}
          track={track}
          playerBodyColor={team.primaryColor}
          playerAccentColor={team.secondaryColor}
          rivals={rivals}
          playerCode={driver.code}
          playerName={driver.name}
          playerNumber={driver.number}
          playerTeamId={team.id}
          hudRef={hudRef}
          aiMarkerEls={aiMarkerEls}
          raceLaps={raceLaps}
          champRound={champRound}
          sessionMode={sessionMode}
          qualiFormat={format}
          timeAttack={timeAttack}
          netRole={netActive && netValid ? netRole : null}
          netHumanSlots={(netActive && netValid ? (roomState?.members ?? []) : []).map((_, index) => index)}
          countdownGoAtMs={countdownGoAtMs}
          playerGridSpot={playerGridSpot}
          difficulty={difficulty}
          carSetup={carSetup}
          countdownRef={countdownRef}
          countdownValueRef={countdownValueRef}
          audioRef={audioRef}
          touchInputRef={touchInputRef}
          timeOfDay={timeOfDay}
          paused={singlePlayer ? menuOpen || result !== null : false}
          onPauseToggle={singlePlayer ? toggleMenu : undefined}
          onReady={handleSceneReady}
          weatherPreset={weatherPreset}
          weatherPlan={weatherPlan}
          raceCommandsRef={raceCommandsRef}
          raceOpsSnapshotRef={raceOpsSnapshotRef}
          telemetryRef={telemetryOpen ? telemetryRef : undefined}
          perfRef={perfRef}
          sideMirrorsEnabled={sideMirrorsEnabled}
        />
        {!sceneReady && <TrackLoadingFallback track={track} />}
        <div className={hudStyles.hud}>
          {!qualifyingSession && (
            <Tower hudRef={hudRef} trackName={trackName} initialRows={initialTowerRows} />
          )}
          <Timing hudRef={hudRef} />
          <Notifications hudRef={hudRef} />
          <Engineer hudRef={hudRef} />
          <TrackMap
            hudRef={hudRef}
            track={track}
            rivals={rivals}
            aiMarkerEls={aiMarkerEls}
            playerColor={team.primaryColor}
            showRivals={!qualifyingSession}
          />
          <Mfd hudRef={hudRef} />
          <div className={hudStyles.muteChip} ref={muteRef} />
          {/* The only mode with no natural end, so it keeps a visible way
              back to the board (a race or qualifying ends on the results
              screen, which has its own). */}
          {timeAttack && (
            <Link className={hudStyles.backLink} href="/time-trial">
              &larr; YOUR TIMES
            </Link>
          )}
        </div>
        <ResultWatcher hudRef={hudRef} onResult={setResult} />
        <div className={styles.perf} ref={perfRef} aria-live="off" />
        <RaceAudioRig audioRef={audioRef} muteRef={muteRef} />
        <Haptics audioRef={audioRef} />
        <RaceOpsPanel
          commandRef={raceCommandsRef}
          snapshotRef={raceOpsSnapshotRef}
          open={raceOpsOpen}
          onToggle={toggleRaceOps}
        />
        {telemetryOpen && <TelemetryPanel sampleRef={telemetryRef} />}
        {settingsOpen && <ControlSettingsPanel />}
        {sceneReady && (
          <div
            className={styles.startSequence}
            ref={countdownRef}
            data-active="true"
            data-phase="waiting"
            data-value="3"
          >
            <div className={styles.startLights} aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => (
                <span className={styles.startLight} key={index}>
                  <i />
                  <i />
                </span>
              ))}
            </div>
            <span
              className={styles.startCountdownValue}
              ref={countdownValueRef}
              aria-live="assertive"
              aria-atomic="true"
            />
            <div className={styles.startSequenceFooter}>
              P{playerGridSpot} ON THE GRID · {sessionLabel}
            </div>
          </div>
        )}
      </div>
      <MobileControls
        inputRef={touchInputRef}
        disabled={singlePlayer && menuOpen}
        onPause={toggleMenu}
        onReplay={toggleMobileReplay}
        onToggleSideMirrors={toggleSideMirrors}
        sideMirrorsEnabled={sideMirrorsEnabled}
      />
      {menuOpen && !result && (
        <PauseMenu
          trackName={track.name}
          sessionLabel={sessionLabel}
          online={!singlePlayer}
          onResume={toggleMenu}
          onRestart={restart}
        />
      )}
      {result && <Results result={result} trackName={track.name.toUpperCase()} onRestart={restart} />}
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}

/** Lifts the session result out of the HUD snapshot into React state, once. */
function ResultWatcher({
  hudRef,
  onResult,
}: {
  hudRef: React.RefObject<HudSnapshot>;
  onResult: (result: SessionResult) => void;
}) {
  const sentRef = useRef<SessionResult | null>(null);
  useHudFrame(() => {
    const result = hudRef.current.result;
    if (result && result !== sentRef.current) {
      sentRef.current = result;
      onResult(result);
    }
  }, 5);
  return null;
}
