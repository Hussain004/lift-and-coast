// Photo mode: a paused, HUD-free free camera with a field of view, a roll and
// a "save image" button. This is only the shared state and its rules; Scene's
// ChaseCamera applies it and app/race/PhotoPanel.tsx edits it.
export interface PhotoState {
  active: boolean;
  fovDeg: number;
  rollDeg: number;
  /** Set by the panel; the camera clears it after taking the picture. */
  capture: boolean;
  /** File name for the next capture. */
  filename: string;
}

export const PHOTO_FOV_MIN = 20;
export const PHOTO_FOV_MAX = 90;
export const PHOTO_ROLL_MAX = 25;
export const PHOTO_DEFAULT_FOV = 55;

export function createPhotoState(): PhotoState {
  return { active: false, fovDeg: PHOTO_DEFAULT_FOV, rollDeg: 0, capture: false, filename: "lift-and-coast.png" };
}

export function clampPhoto(state: PhotoState): PhotoState {
  state.fovDeg = Math.min(PHOTO_FOV_MAX, Math.max(PHOTO_FOV_MIN, state.fovDeg));
  state.rollDeg = Math.min(PHOTO_ROLL_MAX, Math.max(-PHOTO_ROLL_MAX, state.rollDeg));
  return state;
}

/** "lift-and-coast-monza-20260929-143005.png": safe for any file system. */
export function photoFilename(trackName: string, at: Date): string {
  const slug = trackName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  return `lift-and-coast-${slug || "race"}-${stamp}.png`;
}
