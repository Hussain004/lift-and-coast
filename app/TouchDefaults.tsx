"use client";

import { useEffect } from "react";
import { PRESETS, applyAssistPreset } from "./AssistPresets";
import { saveGraphicsPref } from "@/lib/render/quality";
import { loadSessionSetupPrefs, saveSessionSetupPrefs } from "@/lib/race/sessionSetup";
import { TOUCH_RIVALS, markTouchDefaultsApplied, shouldApplyTouchDefaults } from "@/lib/settings/touchDefaults";

/**
 * Mounted once in the root layout. On the first real touch it applies the
 * phone defaults (Low graphics, 9 rivals, Casual assists) and never again.
 */
export function TouchDefaults() {
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      let storage: Storage | null = null;
      try {
        storage = window.localStorage;
      } catch {
        return;
      }
      const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
      if (!shouldApplyTouchDefaults(e.pointerType, storage, coarse)) {
        // Already set up (or not a phone): never ask again, so a later wipe of
        // one setting cannot re-trigger defaults over the player's choices.
        if (e.pointerType === "touch" && coarse) markTouchDefaultsApplied(storage);
        return;
      }
      markTouchDefaultsApplied(storage);
      saveGraphicsPref("low");
      const prefs = loadSessionSetupPrefs();
      saveSessionSetupPrefs({ ...prefs, rivals: Math.min(prefs.rivals, TOUCH_RIVALS) });
      applyAssistPreset(PRESETS[0]); // Casual
    };
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, []);
  return null;
}
