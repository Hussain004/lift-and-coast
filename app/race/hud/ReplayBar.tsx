"use client";

import { useEffect, useState } from "react";
import { formatRaceTime } from "@/lib/race/hud";
import type { Clip } from "@/lib/race/raceRecorder";
import {
  cycleSpeed,
  followCar,
  replayClips,
  seekReplay,
  setHighlights,
  stepClip,
  toggleView,
  togglePlay,
  type RaceReplay,
} from "@/lib/race/raceReplay";
import styles from "./hud.module.css";

interface View {
  t: number;
  duration: number;
  playing: boolean;
  speed: number;
  follow: number;
  tv: boolean;
  highlights: boolean;
  label: string;
  clips: Clip[];
}

function read(replay: RaceReplay, drivers: readonly string[]): View {
  const clip = replay.clips?.[replay.clipIndex];
  return {
    t: replay.t,
    duration: replay.recorder.duration(),
    playing: replay.playing,
    speed: replay.speed,
    follow: replay.follow,
    tv: replay.view === "tv",
    highlights: replay.clips !== null,
    label: clip ? clip.label : `FOLLOWING ${drivers[replay.follow] ?? ""}`,
    clips: replayClips(replay),
  };
}

/**
 * Controls for the post-race replay: play/pause, speed, highlights, who to
 * follow, the camera, and a scrub bar with the highlight moments marked.
 * Space plays/pauses, [ ] step clips, Esc goes back to the results.
 */
export function ReplayBar({
  replayRef,
  drivers,
  onExit,
}: {
  replayRef: React.RefObject<RaceReplay>;
  /** Driver codes in car-index order (0 = the player). */
  drivers: readonly string[];
  onExit: () => void;
}) {
  const [view, setView] = useState<View | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => setView(read(replayRef.current, drivers)), 100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
      else if (e.key === " ") togglePlay(replayRef.current);
      else if (e.key === "]") stepClip(replayRef.current, 1);
      else if (e.key === "[") stepClip(replayRef.current, -1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [replayRef, drivers, onExit]);

  if (view === null) return null;
  const clips = view.clips;
  const pct = (t: number) => `${view.duration > 0 ? (t / view.duration) * 100 : 0}%`;
  return (
    <div className={styles.replayBar} role="group" aria-label="Replay controls">
      <div className={styles.replayTop}>
        <b>REPLAY</b>
        <span>{view.label}</span>
        <span>
          {formatRaceTime(view.t)} / {formatRaceTime(view.duration)}
        </span>
      </div>
      <div
        className={styles.replayScrub}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.round(view.duration)}
        aria-valuenow={Math.round(view.t)}
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          seekReplay(replayRef.current, Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * view.duration);
        }}
      >
        <i style={{ width: pct(view.t) }} />
        {clips.map((c) => (
          <em key={c.from} style={{ left: pct(c.from), width: pct(c.to - c.from) }} title={c.label} />
        ))}
      </div>
      <div className={styles.replayButtons}>
        <button type="button" onClick={() => togglePlay(replayRef.current)}>
          {view.playing ? "PAUSE" : "PLAY"}
        </button>
        <button type="button" onClick={() => stepClip(replayRef.current, -1)} aria-label="Previous highlight">
          ◀ CLIP
        </button>
        <button type="button" onClick={() => stepClip(replayRef.current, 1)} aria-label="Next highlight">
          CLIP ▶
        </button>
        <button type="button" data-on={view.highlights ? "1" : undefined} onClick={() => setHighlights(replayRef.current, !view.highlights)}>
          HIGHLIGHTS
        </button>
        <button type="button" onClick={() => cycleSpeed(replayRef.current)}>
          {view.speed}×
        </button>
        <button type="button" onClick={() => toggleView(replayRef.current)}>
          {view.tv ? "TV CAM" : "CHASE CAM"}
        </button>
        <select
          value={view.follow}
          onChange={(e) => followCar(replayRef.current, Number(e.target.value))}
          aria-label="Car to follow"
        >
          {drivers.map((code, i) => (
            <option key={i} value={i}>
              {i === 0 ? `${code} (you)` : code}
            </option>
          ))}
        </select>
        <button type="button" onClick={onExit}>
          BACK TO RESULTS
        </button>
      </div>
    </div>
  );
}
