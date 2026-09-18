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
import { parseRaceLaps, parseTimeOfDay } from "@/lib/race/sessionSetup";
import { parseChampRound } from "@/lib/race/championship";
import { parseDriverCode, parseTeamId, resolveRosterSelection } from "@/lib/race/roster";
import { defaultAudioSnapshot } from "@/lib/audio/raceAudio";
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
  const track = getTrack(parseTrackId(searchParams.get("track")));
  const trackName = track.name.toUpperCase();
  // Garage pick from the home screen (see lib/race/roster.ts): the player
  // runs the team primary, the teammate-opponent the secondary.
  const { team } = resolveRosterSelection(
    parseTeamId(searchParams.get("team")),
    parseDriverCode(searchParams.get("driver"))
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
  const aiMinimapMarkerRef = useRef<SVGCircleElement>(null);
  const positionRef = useRef<HTMLDivElement>(null);
  const raceResultRef = useRef<HTMLDivElement>(null);
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
        track={track}
        playerBodyColor={team.primaryColor}
        aiBodyColor={team.secondaryColor}
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
        aiMinimapMarkerRef={aiMinimapMarkerRef}
        positionRef={positionRef}
        raceResultRef={raceResultRef}
        raceLaps={raceLaps}
        champRound={champRound}
        countdownRef={countdownRef}
        qualifyingDisplayRef={qualifyingDisplayRef}
        penaltyToastRef={penaltyToastRef}
        audioRef={audioRef}
        timeOfDay={timeOfDay}
      />
      <RaceAudioRig audioRef={audioRef} muteRef={muteRef} />
      <div className={styles.hud}>
        <span className={styles.trackName}>{trackName}</span>
        WASD / arrows to drive. Hold R to rewind. Hold Shift to deploy. Press
        E to toggle aero mode. Press C to cycle cameras, V for orbit view. Press 1/2/3 for
        soft/medium/hard tires. Press T to toggle TC, B to toggle ABS, L to
        toggle the racing line. Q/Z to shift gears, G to toggle auto-gears.
        Press M to mute. A connected gamepad/wheel drives with analog
        steering (left stick) and throttle/brake (stick or triggers)
        automatically.
      </div>
      <div className={styles.lap} ref={lapRef}>
        LAP 1 --:--.---  BEST --:--.---
      </div>
      <div className={styles.position} ref={positionRef}>
        P1
      </div>
      <div className={styles.raceResult} ref={raceResultRef} />
      <div className={styles.qualifying} ref={qualifyingDisplayRef} />
      <div className={styles.countdown} ref={countdownRef} />
      <div className={styles.delta} ref={deltaRef} />
      <div className={styles.sectors} ref={sectorsRef} />
      <div className={styles.speed} ref={speedRef}>
        0 km/h
      </div>
      <div className={styles.gearBox}>
        <div className={styles.rpmTrack}>
          <div className={styles.rpmFill} ref={rpmRef} />
        </div>
        <div className={styles.gear} ref={gearRef}>
          1
        </div>
      </div>
      <div className={styles.aeroMode} ref={aeroModeRef} />
      <div className={styles.tire} ref={tireRef} />
      <div className={styles.assists} ref={assistsRef} />
      <div className={styles.damage} ref={damageRef} />
      <div className={styles.mute} ref={muteRef} />
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
          {/* AI opponent - a plain world-space dot inside the same rotating
              group as the track path, so it inherits the egocentric
              transform for free instead of needing its own rotation math
              (unlike the player's own fixed, always-up-pointing marker
              below). Matches the teammate-opponent's own chassis color. */}
          <circle ref={aiMinimapMarkerRef} cx={track.startPos.x} cy={track.startPos.z} r={5} fill={team.secondaryColor} />
        </g>
        {/* Fixed at the box center, always pointing up - the world rotates
            around this marker instead of the marker rotating, so there's no
            heading-arrow rotation math to get backwards. */}
        <polygon ref={minimapMarkerRef} points={MINIMAP_MARKER_POINTS} fill={team.primaryColor} />
      </svg>
      <div className={styles.energyTrack}>
        <div className={styles.energyFill} ref={energyRef} />
      </div>
      {/* Diagnostic output for the debug-drive-request hook in Car.tsx -
          see the comment there. */}
      <div id="__debug-output" style={{ display: "none" }} />
    </div>
  );
}
