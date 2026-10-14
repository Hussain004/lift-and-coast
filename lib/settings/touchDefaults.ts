// First-touch defaults: a phone or tablet is a weak GPU with no keyboard, so
// the first time the page sees a real touch it switches to the lightest
// graphics, a smaller grid and the Casual assists, once. Anything the player
// changes afterwards is never overwritten, because the flag is stored.

const KEY = "lift-and-coast.touch-defaults.v1";

/** Rivals on a touch device: enough to feel like a race, light enough to hold frame rate. */
export const TOUCH_RIVALS = 9;

/**
 * Keys that mean "this browser has already been set up": a returning player
 * (or a touchscreen laptop that already has its settings) must never have
 * them overwritten by a first tap.
 */
export const EXISTING_PREF_KEYS = [
  "lift-and-coast.graphics.v1",
  "lift-and-coast.session-setup.v1",
  "lift-and-coast.controls.v1",
] as const;

/**
 * True only for a genuine first visit on a touch-first device: a touch
 * pointer, a coarse primary pointer (so a touchscreen laptop with a mouse is
 * excluded), no flag yet, and none of the existing preference keys.
 */
export function shouldApplyTouchDefaults(
  pointerType: string,
  storage: Pick<Storage, "getItem"> | null,
  coarsePrimaryPointer: boolean
): boolean {
  if (pointerType !== "touch" || !coarsePrimaryPointer) return false;
  try {
    if (storage?.getItem(KEY) !== null) return false;
    return EXISTING_PREF_KEYS.every((key) => storage?.getItem(key) === null);
  } catch {
    return false;
  }
}

export function markTouchDefaultsApplied(storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(KEY, "1");
  } catch {
    // Non-fatal: the defaults could be applied again next visit.
  }
}
