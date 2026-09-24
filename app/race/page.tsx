"use client";

import dynamic from "next/dynamic";
import { Suspense, useCallback, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./race.module.css";
import {
  MINIMAP_SIZE_PX,
  buildMinimapPath,
  computeMinimapTransform,
} from "@/lib/tracks/minimap";
import { getTrack } from "@/lib/tracks/trackData";
import { parseTrackId } from "@/lib/tracks/registry";
import { parseWeatherPreset } from "@/lib/physics/weather";
import type { RaceOpsCommand, RaceOpsSnapshot } from "@/lib/race/raceOps";
import { parseRaceLaps, parseTimeOfDay, parseSessionMode, parseQualifyingFormat, parseGridSpot, parseRivals, parseDifficulty, parseSeed, MAX_FIELD_SIZE } from "@/lib/race/sessionSetup";
import { parseChampRound } from "@/lib/race/championship";
import { parseDriverCode, parseTeamId, resolveFieldRoster, resolveNetGridRoster } from "@/lib/race/roster";
import { parseGridOrder, shuffledGridOrder } from "@/lib/race/rosterData";
import { netRoom } from "@/lib/net/peer";
import { isRoomCode } from "@/lib/net/protocol";
import { defaultAudioSnapshot } from "@/lib/audio/raceAudio";
import { ControlsPanel } from "./ControlsPanel";
import { RaceAudioRig } from "./RaceAudioRig";
import { RaceOpsPanel } from "./RaceOpsPanel";
import { MobileControls } from "./MobileControls";
import { createTouchDriveInput, type TouchDriveInput } from "@/lib/input/touch";

const Scene = dynamic(() => import("./Scene").then((mod) => mod.Scene), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading track...</div>,
});

const MINIMAP_CENTER_PX = MINIMAP_SIZE_PX / 2;
const MINIMAP_MARKER_POINTS =
  `${MINIMAP_CENTER_PX},${MINIMAP_CENTER_PX - 8} ` +
  `${MINIMAP_CENTER_PX - 6},${MINIMAP_CENTER_PX + 6} ` +
  `${MINIMAP_CENTER_PX + 6},${MINIMAP_CENTER_PX + 6}`;

export default function RacePage() {
  return (
    // useSearchParams requires a Suspense boundary for static prerendering
    // (Next.js opts the whole route into client-only rendering below it
    // otherwise) - the fallback is never actually seen in practice, since
    // this whole page is already client-only ("use client" above) and the
    // param read resolves synchronously on first render.
    <Suspense fallback={null}>
      <RaceContent />
    </Suspense>
  );
}

function RaceContent() {
  const searchParams = useSearchParams();
  const raceLaps = parseRaceLaps(searchParams.get("laps"));
  const qualiFormat = parseQualifyingFormat(searchParams.get("qformat"));
  const rivalCount = parseRivals(searchParams.get("rivals"));
  // AI field character (see lib/ai/personalities.ts): the meeting
  // difficulty tier travels on ?diff=, defaulting to Pro (today's
  // reference pace) so every existing link drives exactly as before. In
  // net rooms the host simulates, so the host's tier sets the field.
  const difficulty = parseDifficulty(searchParams.get("diff"));
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
  // Garage pick from the home screen (see lib/race/roster.ts): the player
  // runs their own team's primary, and every rival runs its own team's
  // primary - a full grid dresses per team, like the real thing. In net
  // rooms the humans come from the lobby roster (join order = grid
  // order) with the same deterministic AI fill on both sides (see
  // resolveNetGridRoster), so host and guest dress the same grid.
  const { team, driver, rivals: soloRivals } = resolveFieldRoster(
    parseTeamId(searchParams.get("team")),
    parseDriverCode(searchParams.get("driver")),
    rivalCount
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
          Math.max(0, totalCars - humans.length)
        );
        const grid = [...humans, ...fill];
        return grid
          .map((entry, slot) => ({ entry, slot }))
          .filter(({ slot }) => slot !== playerSlot)
          .map(({ entry }) => entry);
      })();
  const sessionMode = netActive && netValid ? "race" : parseSessionMode(searchParams.get("mode"));
  const champRound = netActive ? null : parseChampRound(searchParams.get("champ"));
  // Random grid for quick races (?seed= from the home Drive link): the
  // whole field - player included - shuffles, so nobody is gifted pole.
  // Explicit grids always win, in this order: a full ?order= board (the
  // qualifying banner), ?grid= (qualifying/championship panels), then
  // ?seed=, then the legacy pole start. Net rooms always use join order.
  // Missing or unparseable values fall through to the next source, so
  // every old link drives exactly as before. Pure over the URL (seeded
  // shuffle), so refreshes and shared links reproduce the same grid.
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
  const weatherPreset = parseWeatherPreset(searchParams.get("weather"));
  // Resolved per-render from the selected track - only changes on a URL
  // change (this page is client-only with no other state), so the build
  // cost is paid once per session.
  const minimapPathD = buildMinimapPath(track);
  // Matches the chassis's own spawn rotation (rotation={[0, startPos.headingRad, 0]}
  // in Car.tsx) exactly, so there's no visible snap on the first live frame.
  const initialMinimapTransform = computeMinimapTransform(
    track.startPos.x,
    track.startPos.z,
    track.startPos.headingRad
  );
  const speedRef = useRef<HTMLDivElement>(null);
  const lapRef = useRef<HTMLDivElement>(null);
  const deltaRef = useRef<HTMLDivElement>(null);
  const sectorsRef = useRef<HTMLDivElement>(null);
  const trackLimitRef = useRef<HTMLDivElement>(null);
  const energyRef = useRef<HTMLDivElement>(null);
  const aeroModeRef = useRef<HTMLDivElement>(null);
  const tireRef = useRef<HTMLDivElement>(null);
  const assistsRef = useRef<HTMLDivElement>(null);
  const damageRef = useRef<HTMLDivElement>(null);
  const gearRef = useRef<HTMLDivElement>(null);
  const rpmRef = useRef<HTMLDivElement>(null);
  const throttleRef = useRef<HTMLDivElement>(null);
  const brakeRef = useRef<HTMLDivElement>(null);
  const steerMarkerRef = useRef<HTMLDivElement>(null);
  const minimapGroupRef = useRef<SVGGElement>(null);
  const minimapMarkerRef = useRef<SVGPolygonElement>(null);
  // One dot element per rival, written by aiIndex (see AICar.tsx) -
  // callback refs into a shared array, so the count can change without
  // hook-count violations.
  const aiMarkerEls = useRef<(SVGCircleElement | null)[]>([]);
  const positionRef = useRef<HTMLDivElement>(null);
  const raceResultRef = useRef<HTMLDivElement>(null);
  const towerRef = useRef<HTMLDivElement>(null);
  const countdownRef = useRef<HTMLDivElement>(null);
  const qualifyingDisplayRef = useRef<HTMLDivElement>(null);
  const penaltyToastRef = useRef<HTMLDivElement>(null);
  const muteRef = useRef<HTMLDivElement>(null);
  const perfRef = useRef<HTMLDivElement>(null);
  // Shared with the race audio rig (see app/race/RaceAudioRig.tsx): both
  // cars write their latest telemetry here every render frame, and the rig
  // pumps it into the synth voices - plain mutable data, never React state,
  // at audio-unrelated rates.
  const audioRef = useRef(defaultAudioSnapshot());
  const touchInputRef = useRef<TouchDriveInput>(createTouchDriveInput());
  const raceCommandsRef = useRef<RaceOpsCommand[]>([]);
  const raceOpsSnapshotRef = useRef<RaceOpsSnapshot | null>(null);
  const [paused, setPaused] = useState(false);
  const togglePaused = useCallback(() => setPaused((value) => !value), []);
  const toggleMobileReplay = useCallback(() => {
    raceCommandsRef.current.push({ type: "toggle-replay" });
  }, []);
  const singlePlayer = !netActive;

  return (
    <div className={styles.wrap}>
      <div className={styles.gameStage}>
        <Scene
        key={`${track.id}-${rivals.length}-${sessionMode}-${difficulty}-${playerGridSpot}-${weatherPreset}-${fullOrder?.join("") ?? gridSeed ?? "pole"}-${netActive ? `${netRole}-${playerSlot}` : "solo"}`}
        track={track}
        playerBodyColor={team.primaryColor}
        playerAccentColor={team.secondaryColor}
        rivals={rivals}
        playerCode={driver.code}
        playerName={driver.name}
        playerNumber={driver.number}
        playerTeamId={team.id}
        speedRef={speedRef}
        lapRef={lapRef}
        deltaRef={deltaRef}
        sectorsRef={sectorsRef}
        trackLimitRef={trackLimitRef}
        energyRef={energyRef}
        aeroModeRef={aeroModeRef}
        tireRef={tireRef}
        assistsRef={assistsRef}
        damageRef={damageRef}
        gearRef={gearRef}
        rpmRef={rpmRef}
         throttleRef={throttleRef}
         brakeRef={brakeRef}
         steerMarkerRef={steerMarkerRef}
        minimapGroupRef={minimapGroupRef}
        minimapMarkerRef={minimapMarkerRef}
        aiMarkerEls={aiMarkerEls}
        positionRef={positionRef}
        raceResultRef={raceResultRef}
        towerRef={towerRef}
        raceLaps={raceLaps}
        champRound={champRound}
        sessionMode={sessionMode}
        netRole={netActive && netValid ? netRole : null}
        netHumanSlots={(netActive && netValid ? (roomState?.members ?? []) : []).map((_, index) => index)}
        countdownGoAtMs={countdownGoAtMs}
        qualiFormat={qualiFormat}
        playerGridSpot={playerGridSpot}
        difficulty={difficulty}
        countdownRef={countdownRef}
        qualifyingDisplayRef={qualifyingDisplayRef}
        penaltyToastRef={penaltyToastRef}
        audioRef={audioRef}
        touchInputRef={touchInputRef}
        timeOfDay={timeOfDay}
        paused={singlePlayer ? paused : false}
        onPauseToggle={singlePlayer ? togglePaused : undefined}
        weatherPreset={weatherPreset}
        raceCommandsRef={raceCommandsRef}
        raceOpsSnapshotRef={raceOpsSnapshotRef}
        perfRef={perfRef}
      />
      <div className={styles.raceDataStrip}>
        <div ref={lapRef} className={styles.raceDataLap}>LAP 1</div>
        <div ref={positionRef} className={styles.raceDataPosition}>P1</div>
        <div ref={deltaRef} className={styles.delta} />
        <div ref={sectorsRef} className={styles.sectors} />
      </div>
      <div className={styles.perf} ref={perfRef} aria-live="off" />
      <RaceAudioRig audioRef={audioRef} muteRef={muteRef} />
      <RaceOpsPanel commandRef={raceCommandsRef} snapshotRef={raceOpsSnapshotRef} />
      {/* Compact F1 timing tower: driver, interval and gap only. Car.tsx
          rewrites the rows ~10Hz (see renderTowerHtml), while this static
          first-paint version keeps the grid populated before lights out. */}
      <div className={styles.tower}>
        <div className={styles.towerEvent}>{trackName}</div>
        <div className={styles.towerColumns} aria-hidden="true">
          <span>POS</span>
          <span>DRIVER</span>
          <span>INT</span>
          <span>GAP</span>
        </div>
        <div className={styles.towerRows} ref={towerRef}>
          {initialTowerRows.map((row) => (
            <div
              className={`tower-row${row.isPlayer ? " tower-row-you" : ""}`}
              key={row.code}
              data-code={row.code}
            >
              <span className="tower-pos">P{row.grid}</span>
              <span className="tower-driver">
                <span className="code-chip" style={{ background: row.color }}>
                  {row.code}
                </span>
              </span>
              <span className="tower-interval">—</span>
              <span className="tower-gap">GRID</span>
            </div>
          ))}
        </div>
      </div>
      {/* F1-style broadcast telemetry: a compact carbon strip with the
          gear and speed hierarchy first, then driver inputs and car state. */}
      <div className={styles.bottomBar}>
        <div className={styles.hudTopLine} />
        <div className={styles.gearCluster}>
          <span className={styles.clusterLabel}>GEAR</span>
          <div className={styles.gear} ref={gearRef}>1</div>
        </div>
        <div className={styles.speedCluster}>
          <div className={styles.speedReadout}>
            <div className={styles.speed} ref={speedRef}>0</div>
            <span className={styles.speedUnit}>KM/H</span>
          </div>
          <div className={styles.rpmStack}>
            <div className={styles.barLabel}><span>RPM</span><span>POWER UNIT</span></div>
            <div className={styles.rpmTrack}>
              <div className={styles.rpmFill} ref={rpmRef} />
            </div>
            <div className={styles.energyTrack}>
              <div className={styles.energyFill} ref={energyRef} />
            </div>
            <div className={styles.barLabel}><span>ERS</span><span>DEPLOYMENT</span></div>
          </div>
        </div>
        <div className={styles.inputCluster}>
          <div className={styles.pedalRow}><span>THR</span><div className={styles.pedalTrack}><div className={styles.pedalFillThrottle} ref={throttleRef} /></div></div>
          <div className={styles.pedalRow}><span>BRK</span><div className={styles.pedalTrack}><div className={styles.pedalFillBrake} ref={brakeRef} /></div></div>
          <div className={styles.steerRow}><span>STR</span><div className={styles.steerTrack}><div className={styles.steerMarker} ref={steerMarkerRef} /></div></div>
        </div>
        <div className={styles.hudStatus}>
          <div className={styles.statusCard}><span>TYRE</span><div className={styles.tire} ref={tireRef} /></div>
          <div className={styles.statusCard}><span>AERO</span><div className={styles.aeroMode} ref={aeroModeRef} /></div>
          <div className={styles.statusCard}><span>ASSISTS</span><div className={styles.assists} ref={assistsRef} /></div>
          <div className={styles.statusFooter}><span className={styles.damage} ref={damageRef} /><span className={styles.mute} ref={muteRef} /></div>
        </div>
      </div>
      <div className={styles.raceResult} ref={raceResultRef} />
      <div className={styles.qualifying} ref={qualifyingDisplayRef} />
      <div className={styles.countdown} ref={countdownRef} />
      <div className={styles.trackLimit} ref={trackLimitRef} />
      <div className={styles.penaltyToast} ref={penaltyToastRef} />
      <svg
        className={styles.minimap}
        width={MINIMAP_SIZE_PX}
        height={MINIMAP_SIZE_PX}
        viewBox={`0 0 ${MINIMAP_SIZE_PX} ${MINIMAP_SIZE_PX}`}
      >
        <g ref={minimapGroupRef} transform={initialMinimapTransform}>
          <path d={minimapPathD} fill="none" stroke="#fff" strokeWidth={2.5} />
          <circle cx={track.startPos.x} cy={track.startPos.z} r={3} fill="#ffd23f" />
          {/* One dot per rival, written by aiIndex (see AICar.tsx) - plain
              world-space dots inside the same rotating group as the track
              path, so they inherit the egocentric transform for free. */}
          {rivals.map((rival, k) => (
            <circle
              key={rival.code}
              ref={(el) => {
                aiMarkerEls.current[k] = el;
              }}
              cx={track.startPos.x}
              cy={track.startPos.z}
              r={5}
              fill={rival.color}
            />
          ))}
        </g>
        {/* Fixed at the box center, always pointing up - the world rotates
            around this marker instead of the marker rotating, so there's no
            heading-arrow rotation math to get backwards. */}
        <polygon ref={minimapMarkerRef} points={MINIMAP_MARKER_POINTS} fill={team.primaryColor} />
      </svg>
        <ControlsPanel />
      </div>
      <MobileControls
        inputRef={touchInputRef}
        disabled={singlePlayer && paused}
        onPause={singlePlayer ? togglePaused : undefined}
        onReplay={toggleMobileReplay}
      />
      {singlePlayer && paused && (
        <div className={styles.pauseOverlay} role="dialog" aria-label="Game paused">
          <div className={styles.pauseCard}>
            <strong>PAUSED</strong>
            <span>Press P or tap below to resume</span>
            <button type="button" onClick={togglePaused}>RESUME</button>
          </div>
        </div>
      )}
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
