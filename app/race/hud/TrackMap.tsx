"use client";

import { useMemo, useRef } from "react";
import type { HudSnapshot } from "@/lib/race/hud";
import { buildMinimapPath, computeFullMapTransform } from "@/lib/tracks/minimap";
import type { TrackData } from "@/lib/tracks/types";
import { safeHex, useHudFrame } from "./useHudFrame";
import styles from "./hud.module.css";

const MAP_PX = 176;

/**
 * Bottom-left map of the WHOLE circuit, fixed orientation, every car on it -
 * the F1 game's map rather than the old car-centred crop, which showed
 * ~300m of track and looked empty. The group is world-space scaled once, so
 * each AI car keeps writing its own dot's cx/cy in world metres (AICar.tsx)
 * and the player's marker is written here from the HUD snapshot.
 */
export function TrackMap({
  hudRef,
  track,
  rivals,
  aiMarkerEls,
  playerColor,
  showRivals,
}: {
  hudRef: React.RefObject<HudSnapshot>;
  track: TrackData;
  rivals: readonly { code: string; color: string }[];
  aiMarkerEls: React.RefObject<(SVGCircleElement | null)[]>;
  playerColor: string;
  showRivals: boolean;
}) {
  const { d, transform, scale } = useMemo(() => {
    const fit = computeFullMapTransform(track, MAP_PX, 12);
    return { d: buildMinimapPath(track), ...fit };
  }, [track]);
  const youRef = useRef<SVGCircleElement>(null);

  useHudFrame(() => {
    const hud = hudRef.current;
    const you = youRef.current;
    if (!you) return;
    you.setAttribute("cx", hud.x.toFixed(1));
    you.setAttribute("cy", hud.z.toFixed(1));
    you.setAttribute("fill", hud.offTrack ? "#ff3b3b" : safeHex(playerColor));
  }, 30);

  // Sizes below are in world metres (the group is scaled), so divide the
  // intended screen pixels by the scale.
  const px = (n: number) => n / scale;
  const start = track.centerline[0];
  return (
    <div className={styles.map}>
      <svg width={MAP_PX} height={MAP_PX} viewBox={`0 0 ${MAP_PX} ${MAP_PX}`} aria-label="Track map">
        <g transform={transform}>
          <path d={d} className={styles.mapTrackOutline} strokeWidth={px(7)} />
          <path d={d} className={styles.mapTrack} strokeWidth={px(3)} />
          <rect
            x={start[0] - px(1.5)}
            y={start[2] - px(5)}
            width={px(3)}
            height={px(10)}
            fill="#ffffff"
            transform={`rotate(${((-track.startPos.headingRad * 180) / Math.PI).toFixed(1)} ${start[0]} ${start[2]})`}
          />
          {showRivals &&
            rivals.map((rival, k) => (
              <circle
                key={rival.code}
                ref={(el) => {
                  aiMarkerEls.current[k] = el;
                }}
                cx={track.startPos.x}
                cy={track.startPos.z}
                r={px(3.6)}
                fill={safeHex(rival.color)}
                stroke="#05060a"
                strokeWidth={px(1)}
              />
            ))}
          <circle
            ref={youRef}
            cx={track.startPos.x}
            cy={track.startPos.z}
            r={px(5.5)}
            fill={safeHex(playerColor)}
            stroke="#ffffff"
            strokeWidth={px(2)}
          />
        </g>
      </svg>
    </div>
  );
}
