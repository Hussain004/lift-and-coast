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
  /** Colour grade (see PHOTO_FILTERS). */
  filter: PhotoFilterId;
}

export type PhotoFilterId = "natural" | "warm" | "cool" | "mono" | "film";

/**
 * Colour grades as CSS filter strings: applied to the canvas for the live
 * preview and to a 2D canvas copy when saving, so the file matches what you
 * see and nothing extra renders while racing.
 */
export const PHOTO_FILTERS: { id: PhotoFilterId; label: string; css: string }[] = [
  { id: "natural", label: "Natural", css: "none" },
  { id: "warm", label: "Warm", css: "sepia(0.25) saturate(1.2) contrast(1.05) brightness(1.03)" },
  { id: "cool", label: "Cool", css: "hue-rotate(-12deg) saturate(1.1) contrast(1.06) brightness(0.98)" },
  { id: "mono", label: "Mono", css: "grayscale(1) contrast(1.2)" },
  { id: "film", label: "Film", css: "sepia(0.18) contrast(1.15) saturate(0.85) brightness(0.97)" },
];

export function photoFilterCss(id: PhotoFilterId): string {
  return PHOTO_FILTERS.find((f) => f.id === id)?.css ?? "none";
}

export const PHOTO_FOV_MIN = 20;
export const PHOTO_FOV_MAX = 90;
export const PHOTO_ROLL_MAX = 25;
export const PHOTO_DEFAULT_FOV = 55;

export function createPhotoState(): PhotoState {
  return { active: false, fovDeg: PHOTO_DEFAULT_FOV, rollDeg: 0, capture: false, filename: "lift-and-coast.png", filter: "natural" };
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
