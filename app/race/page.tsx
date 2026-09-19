"use client";

import dynamic from "next/dynamic";
import { Suspense, useRef } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./race.module.css";
import {
  MINIMAP_SIZE_PX,
  buildMinimapPath,
  computeMinimapTransform,
} from "@/lib/tracks/minimap";
import { getTrack } from "@/lib/tracks/trackData";
import { parseTrackId } from "@/lib/tracks/registry";
import { parseRaceLaps, parseTimeOfDay, parseSessionMode, parseQualifyingFormat, parseGridSpot, parseRivals } from "@/lib/race/sessionSetup";
import { parseChampRound } from "@/lib/race/championship";
import { parseDriverCode, parseTeamId, resolveFieldRoster } from "@/lib/race/roster";
import { defaultAudioSnapshot } from "@/lib/audio/raceAudio";
import { ControlsPanel } from "./ControlsPanel";
import { RaceAudioRig } from "./RaceAudioRig";

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
  const champRound = parseChampRound(searchParams.get("champ"));
  const sessionMode = parseSessionMode(searchParams.get("mode"));
  const qualiFormat = parseQualifyingFormat(searchParams.get("qformat"));
  // Explicit grid only (?grid= from a qualifying result or the
  // championship panel) - the race never reads the season itself, so grid
  // assignment stays synchronous with spawning.
  const playerGridSpot = parseGridSpot(searchParams.get("grid"));
  const rivalCount = parseRivals(searchParams.get("rivals"));
  const track = getTrack(parseTrackId(searchParams.get("track")));
  const trackName = track.name.toUpperCase();
  // Garage pick from the home screen (see lib/race/roster.ts): the player
  // runs their own team's primary, and every rival runs its own team's
  // primary - a full grid dresses per team, like the real thing.
  const { team, driver, rivals } = resolveFieldRoster(
    parseTeamId(searchParams.get("team")),
    parseDriverCode(searchParams.get("driver")),
    rivalCount
  );
  const timeOfDay = parseTimeOfDay(searchParams.get("tod"));
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
  // Shared with the race audio rig (see app/race/RaceAudioRig.tsx): both
  // cars write their latest telemetry here every render frame, and the rig
  // pumps it into the synth voices - plain mutable data, never React state,
  // at audio-unrelated rates.
  const audioRef = useRef(defaultAudioSnapshot());

  return (
    <div className={styles.wrap}>
      <Scene
        key={`${track.id}-${rivals.length}-${sessionMode}`}
        track={track}
        playerBodyColor={team.primaryColor}
        rivals={rivals}
        playerCode={driver.code}
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
        minimapGroupRef={minimapGroupRef}
        minimapMarkerRef={minimapMarkerRef}
        aiMarkerEls={aiMarkerEls}
        positionRef={positionRef}
        raceResultRef={raceResultRef}
        towerRef={towerRef}
        raceLaps={raceLaps}
        champRound={champRound}
        sessionMode={sessionMode}
        qualiFormat={qualiFormat}
        playerGridSpot={playerGridSpot}
        countdownRef={countdownRef}
        qualifyingDisplayRef={qualifyingDisplayRef}
        penaltyToastRef={penaltyToastRef}
        audioRef={audioRef}
        timeOfDay={timeOfDay}
      />
      <RaceAudioRig audioRef={audioRef} muteRef={muteRef} />
      {/* Timing tower, broadcast style: live lap/position plus the full
          field below - Car.tsx rewrites the rows ~10Hz (see
          renderTowerHtml), so this container starts with one static row
          per car and never goes stale on first paint. */}
      <div className={styles.tower}>
        <div className={styles.towerEvent}>{trackName}</div>
        <div className={styles.lap} ref={lapRef}>
          LAP 1 --:--.---  BEST --:--.---
        </div>
        <div className={styles.position} ref={positionRef}>
          P1
        </div>
        <div className={styles.towerRows} ref={towerRef}>
          <div className="tower-row tower-row-you">
            <span className="tower-pos">P1</span>
            <span className="code-chip" style={{ background: team.primaryColor }}>
              {driver.code}
            </span>
            <span className="tower-gap">LEADER</span>
          </div>
          {rivals.map((rival) => (
            <div className="tower-row" key={rival.code}>
              <span className="tower-pos">–</span>
              <span className="code-chip" style={{ background: rival.color }}>
                {rival.code}
              </span>
              <span className="tower-gap">…</span>
            </div>
          ))}
        </div>
        <div className={styles.sectors} ref={sectorsRef} />
        <div className={styles.delta} ref={deltaRef} />
      </div>
      {/* Bottom telemetry bar, broadcast style: gear, speed, revs, energy,
          tires, aero and assist flags. */}
      <div className={styles.bottomBar}>
        <div className={styles.gear} ref={gearRef}>
          1
        </div>
        <div className={styles.bbCenter}>
          <div className={styles.speed} ref={speedRef}>
            0 km/h
          </div>
          <div className={styles.rpmTrack}>
            <div className={styles.rpmFill} ref={rpmRef} />
          </div>
          <div className={styles.energyTrack}>
            <div className={styles.energyFill} ref={energyRef} />
          </div>
        </div>
        <div className={styles.bbRight}>
          <div className={styles.tire} ref={tireRef} />
          <div className={styles.aeroMode} ref={aeroModeRef} />
          <div className={styles.assists} ref={assistsRef} />
          <div className={styles.damage} ref={damageRef} />
          <div className={styles.mute} ref={muteRef} />
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
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
