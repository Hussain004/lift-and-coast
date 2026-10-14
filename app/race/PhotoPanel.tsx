"use client";

import { useState } from "react";
import {
  PHOTO_DEFAULT_FOV,
  PHOTO_FOV_MAX,
  PHOTO_FOV_MIN,
  PHOTO_FILTERS,
  PHOTO_ROLL_MAX,
  clampPhoto,
  photoFilename,
  type PhotoFilterId,
  type PhotoState,
} from "@/lib/race/photo";
import hud from "./hud/hud.module.css";

/**
 * Photo mode's control card: field of view, roll, save, exit. The camera
 * itself lives in Scene (drag to orbit, scroll to zoom); this only edits the
 * shared PhotoState the camera reads.
 */
export function PhotoPanel({
  photoRef,
  trackName,
  onExit,
}: {
  photoRef: React.RefObject<PhotoState>;
  trackName: string;
  onExit: () => void;
}) {
  // The page resets the shared state on entry, so a fresh panel starts at the defaults.
  const [fov, setFov] = useState(PHOTO_DEFAULT_FOV);
  const [roll, setRoll] = useState(0);
  const [filter, setFilter] = useState<PhotoFilterId>("natural");
  const edit = (patch: Partial<Pick<PhotoState, "fovDeg" | "rollDeg">>) => {
    Object.assign(photoRef.current, patch);
    clampPhoto(photoRef.current);
    setFov(photoRef.current.fovDeg);
    setRoll(photoRef.current.rollDeg);
  };
  return (
    <div className={hud.photoPanel} role="dialog" aria-label="Photo mode">
      <div className={hud.resultsKicker}>PHOTO MODE</div>
      <label>
        <span>FIELD OF VIEW · {Math.round(fov)}°</span>
        <input type="range" min={PHOTO_FOV_MIN} max={PHOTO_FOV_MAX} value={fov} onChange={(e) => edit({ fovDeg: Number(e.target.value) })} />
      </label>
      <label>
        <span>ROLL · {Math.round(roll)}°</span>
        <input type="range" min={-PHOTO_ROLL_MAX} max={PHOTO_ROLL_MAX} value={roll} onChange={(e) => edit({ rollDeg: Number(e.target.value) })} />
      </label>
      <div role="radiogroup" aria-label="Colour grade" className={hud.photoFilters}>
        {PHOTO_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="radio"
            aria-checked={filter === f.id}
            data-on={filter === f.id ? "1" : undefined}
            onClick={() => {
              photoRef.current.filter = f.id;
              setFilter(f.id);
            }}
          >
            {f.label}
          </button>
        ))}
      </div>
      <p>Drag to orbit, scroll to zoom.</p>
      <button
        type="button"
        className={hud.pauseItem}
        onClick={() => {
          photoRef.current.filename = photoFilename(trackName, new Date());
          photoRef.current.capture = true;
        }}
      >
        SAVE IMAGE
      </button>
      <button type="button" className={hud.pauseItem} onClick={onExit}>
        DONE · ESC
      </button>
    </div>
  );
}
