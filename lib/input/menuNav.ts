// Menu navigation for keyboard arrows and gamepads (D-pad / left stick),
// the way a console game's menus move: focus jumps to the nearest control in
// the pressed direction. Pure geometry here; app/MenuNavigator.tsx wires it
// to the DOM and the Gamepad API.

export type NavDirection = "up" | "down" | "left" | "right";

export interface NavRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Index of the best candidate to move to from `from` in `dir`, or -1. A
 * candidate must lie in the pressed direction (its near edge past our
 * centre); among those, the score favours staying in line - orthogonal
 * drift costs three times as much as distance - so Down in a column goes to
 * the next row, not a far-off diagonal.
 */
export function pickNavTarget(from: NavRect, candidates: readonly NavRect[], dir: NavDirection): number {
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((r, i) => {
    const rx = r.x + r.width / 2;
    const ry = r.y + r.height / 2;
    if (rx === cx && ry === cy && r.width === from.width && r.height === from.height) return;
    let primary: number;
    let ortho: number;
    switch (dir) {
      case "down":
        if (r.y + r.height / 2 <= cy + 1) return;
        primary = Math.max(0, r.y - (from.y + from.height));
        ortho = Math.max(0, Math.abs(rx - cx) - (r.width + from.width) / 2);
        break;
      case "up":
        if (r.y + r.height / 2 >= cy - 1) return;
        primary = Math.max(0, from.y - (r.y + r.height));
        ortho = Math.max(0, Math.abs(rx - cx) - (r.width + from.width) / 2);
        break;
      case "right":
        if (r.x + r.width / 2 <= cx + 1) return;
        primary = Math.max(0, r.x - (from.x + from.width));
        ortho = Math.max(0, Math.abs(ry - cy) - (r.height + from.height) / 2);
        break;
      case "left":
        if (r.x + r.width / 2 >= cx - 1) return;
        primary = Math.max(0, from.x - (r.x + r.width));
        ortho = Math.max(0, Math.abs(ry - cy) - (r.height + from.height) / 2);
        break;
    }
    // Centre distance breaks ties between equally-aligned candidates.
    const centre = Math.hypot(rx - cx, ry - cy) * 0.01;
    const score = primary + ortho * 3 + centre;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

/** Standard-mapping gamepad buttons the menus use. */
export const PAD = { a: 0, b: 1, up: 12, down: 13, left: 14, right: 15 } as const;

const STICK_THRESHOLD = 0.6;

/** The direction a standard gamepad is pressing (D-pad first, then stick). */
export function padDirection(buttons: readonly { pressed: boolean }[], axes: readonly number[]): NavDirection | null {
  if (buttons[PAD.up]?.pressed) return "up";
  if (buttons[PAD.down]?.pressed) return "down";
  if (buttons[PAD.left]?.pressed) return "left";
  if (buttons[PAD.right]?.pressed) return "right";
  const [x = 0, y = 0] = axes;
  if (Math.abs(x) < STICK_THRESHOLD && Math.abs(y) < STICK_THRESHOLD) return null;
  if (Math.abs(y) >= Math.abs(x)) return y < 0 ? "up" : "down";
  return x < 0 ? "left" : "right";
}

/** Hold-to-repeat timing, like a console menu: a pause, then a steady rate. */
export const REPEAT_DELAY_MS = 360;
export const REPEAT_RATE_MS = 120;

export function shouldRepeat(heldForMs: number, lastFireMs: number, nowMs: number): boolean {
  if (heldForMs < REPEAT_DELAY_MS) return false;
  return nowMs - lastFireMs >= REPEAT_RATE_MS;
}
