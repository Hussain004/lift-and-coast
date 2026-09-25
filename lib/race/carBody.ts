// Car-body data that isn't geometry: the active-aero flap's travel and
// actuator, and the second livery colour. The sculpted shapes themselves live
// in lib/race/carSculpt.ts (rendered by app/race/CarBodyMesh.tsx).

// Active aero (plan section 5 + the E-key aero toggle in useDriveInput): the
// flap element parks at a real wing's angle of attack, and low-drag mode adds
// the pivot rotation on top of it.
/** Park angle of the shut active-aero flap: trailing edge already up, like a
 * real rear-wing element (applied to the mesh inside the pivot group). */
export const FLAP_CLOSED_INCLINE_RAD = -0.3;
/** Pivot rotation added in low-drag mode (see Car.tsx) - with the park angle
 * that is about 49 degrees of travel. */
export const FLAP_OPEN_RAD = -0.55;
/** Flap actuator speed - snaps open/shut in about a fifth of a second. */
export const FLAP_RATE_RAD_S = 2.5;

/** Maximum visual steering-wheel lock for the helmet camera. */
export const STEERING_WHEEL_MAX_RAD = Math.PI * 0.72;

/** Map the shaped driver command to a bounded steering-wheel angle. */
export function steeringWheelAngle(steer: number): number {
  return Math.max(-1, Math.min(1, steer)) * STEERING_WHEEL_MAX_RAD;
}

/** Rate-limited step toward the flap target: no overshoot, dt-safe. */
export function stepFlapAngle(current: number, target: number, dtSeconds: number): number {
  const remaining = target - current;
  const step = Math.sign(remaining) * Math.min(Math.abs(remaining), FLAP_RATE_RAD_S * Math.max(0, dtSeconds));
  return current + step;
}

/** Neutral silver for cars whose livery has no second paint (see
 * computeAccentColor). */
export const DEFAULT_ACCENT_COLOR = "#e8e9ec";

/**
 * The second livery color: a team's secondary paint when the caller has one
 * (see page.tsx's roster pick), otherwise derived from the primary by
 * pulling 55% toward whichever end keeps the stripe readable - dark paints
 * lighten, very light paints darken. Unparseable input falls back to a
 * neutral silver rather than throwing, the same unknown-tolerant contract
 * as parseTeamId.
 */
export function computeAccentColor(primary: string): string {
  const rgb = parseHexColor(primary);
  if (!rgb) return DEFAULT_ACCENT_COLOR;
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const target = luminance > 0.62 ? 0 : 255;
  const mix = 0.55;
  return toHexColor([
    r + (target - r) * mix,
    g + (target - g) * mix,
    b + (target - b) * mix,
  ]);
}

/** "#rgb" / "#rrggbb" -> channels, or null when the string is not a color. */
function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

function toHexColor(rgb: readonly number[]): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")
    )
    .join("")}`;
}
