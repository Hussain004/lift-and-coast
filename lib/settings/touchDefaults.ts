// First-touch defaults: a phone or tablet is a weak GPU with no keyboard, so
// the first time the page sees a real touch it switches to the lightest
// graphics, a smaller grid and the Casual assists, once. Anything the player
// changes afterwards is never overwritten, because the flag is stored.

const KEY = "lift-and-coast.touch-defaults.v1";

/** Rivals on a touch device: enough to feel like a race, light enough to hold frame rate. */
export const TOUCH_RIVALS = 9;

export function shouldApplyTouchDefaults(
  pointerType: string,
  storage: Pick<Storage, "getItem"> | null
): boolean {
  if (pointerType !== "touch") return false;
  try {
    return storage?.getItem(KEY) === null;
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
