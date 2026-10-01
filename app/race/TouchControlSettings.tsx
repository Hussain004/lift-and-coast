"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_TOUCH_CONTROL_MODE,
  TOUCH_CONTROL_MODE_OPTIONS,
  TOUCH_STICK_SIZE_OPTIONS,
  loadTouchControlMode,
  loadTouchStickSize,
  loadTiltSteerInvert,
  parseTouchControlMode,
  saveTouchControlMode,
  saveTouchStickSize,
  saveTiltSteerInvert,
  type TouchControlMode,
  type TouchStickSize,
} from "@/lib/input/touchSettings";
import {
  calibrateTilt,
  createTiltCalibration,
  isTiltSupported,
  requestTiltPermission,
  type TiltCalibration,
} from "@/lib/input/tilt";
import styles from "./race.module.css";

/**
 * Touch control settings, in the pause menu (roadmap 13).
 *
 * In Settings rather than on the touch deck on purpose. The deck's header is
 * hidden on a phone in landscape (see the `pointer: coarse` rule in
 * race.module.css) because it sat on top of the race HUD - so anything the
 * player needs to change between sessions belongs here, and the deck itself
 * keeps only what has to be reachable mid-session.
 *
 * The calibration state is deliberately module-level rather than React state:
 * it has to survive the pause menu opening and closing, because re-calibrating
 * every time the player checks the settings would be useless - the whole point
 * is to hold the phone the way you drive and remember it.
 */
let sharedCalibration: TiltCalibration = createTiltCalibration();

const MODE_LABELS: Record<TouchControlMode, string> = {
  sticks: "STICKS",
  tilt: "TILT",
  buttons: "PADS",
};

export function TouchControlSettings({ onModeChange }: { onModeChange?: (mode: TouchControlMode) => void }) {
  const [mode, setMode] = useState<TouchControlMode>(() => loadTouchControlMode());
  const [stickSize, setStickSize] = useState<TouchStickSize>(() => loadTouchStickSize());
  const [invert, setInvert] = useState(() => loadTiltSteerInvert());
  const [tiltGranted, setTiltGranted] = useState(false);
  const supported = typeof window !== "undefined" && isTiltSupported(window);

  useEffect(() => {
    if (mode !== "tilt") onModeChange?.(mode);
  }, [mode, onModeChange]);

  const choose = useCallback(
    (next: TouchControlMode) => {
      setMode(next);
      saveTouchControlMode(next);
      onModeChange?.(next);
      // The touch deck is already mounted behind the pause menu, so it is
      // told directly rather than waiting for a reload to pick the change up.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("lift-and-coast:touch-control-mode"));
      }
    },
    [onModeChange]
  );

  /**
   * The iOS permission tap. Must be a real user gesture: iOS 13+ rejects
   * requestPermission() called from anywhere else, and tilt is simply
   * unavailable on an iPhone without this button.
   */
  const enableTilt = useCallback(async () => {
    const granted = await requestTiltPermission();
    setTiltGranted(granted);
    if (granted) {
      // Recalibrate on the spot: the player is holding the phone in front of
      // them at the moment they tap, which is the only time a neutral reading
      // is guaranteed to mean anything.
      sharedCalibration = createTiltCalibration();
    }
    return granted;
  }, []);

  // Exposed for the in-race RECENTRE affordance, which needs the same object.
  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as unknown as { __liftRecalibrateTilt?: () => void }).__liftRecalibrateTilt = () => {
        sharedCalibration = createTiltCalibration();
      };
      (window as unknown as { __liftTiltCalibration?: TiltCalibration }).__liftTiltCalibration =
        sharedCalibration;
    }
  }, []);

  return (
    <div className={styles.touchSettings} role="group" aria-label="Touch controls">
      <span className={styles.touchSettingsLabel}>STEERING</span>
      <div className={styles.touchSettingsRow}>
        {TOUCH_CONTROL_MODE_OPTIONS.map((option) => {
          // Tilt is only offered where there is a sensor to read. Offering it
          // on a desktop would be a control that silently does nothing.
          if (option === "tilt" && !supported) return null;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={mode === option}
              aria-label={`${option} steering mode`}
              className={`${styles.touchSizeButton} ${mode === option ? styles.touchSizeButtonActive : ""}`}
              onClick={() => choose(option)}
            >
              {MODE_LABELS[option]}
            </button>
          );
        })}
      </div>

      {mode === "sticks" && (
        <>
          <span className={styles.touchSettingsLabel}>STICK SIZE</span>
          <div className={styles.touchSettingsRow}>
            {TOUCH_STICK_SIZE_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={stickSize === option}
                aria-label={`${option} joystick size`}
                className={`${styles.touchSizeButton} ${stickSize === option ? styles.touchSizeButtonActive : ""}`}
                onClick={() => {
                  setStickSize(option);
                  saveTouchStickSize(option);
                }}
              >
                {option === "small" ? "S" : option === "medium" ? "M" : "L"}
              </button>
            ))}
          </div>
        </>
      )}

      {mode === "tilt" && (
        <div className={styles.touchSettingsRow}>
          <button type="button" className={styles.tiltEnable} onClick={enableTilt} aria-label="Enable tilt steering">
            {tiltGranted ? "RECENTRE TILT" : "ENABLE TILT"}
          </button>
          <button
            type="button"
            aria-pressed={invert}
            aria-label="Invert tilt steering direction"
            className={`${styles.touchSizeButton} ${invert ? styles.touchSizeButtonActive : ""}`}
            onClick={() => {
              setInvert(!invert);
              saveTiltSteerInvert(!invert);
            }}
          >
            {invert ? "FLIPPED" : "FLIP"}
          </button>
        </div>
      )}

      {mode === "tilt" && !tiltGranted && (
        <p className={styles.touchSettingsNote}>
          Hold the phone the way you drive and tap enable. If the car turns the wrong way, use FLIP.
        </p>
      )}
    </div>
  );
}

/** Used by tests and by the in-race RECENTRE button. */
export function resetSharedTiltCalibration(): void {
  sharedCalibration = createTiltCalibration();
}

export { calibrateTilt, parseTouchControlMode, DEFAULT_TOUCH_CONTROL_MODE };
