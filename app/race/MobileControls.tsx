"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./race.module.css";
import {
  resetTouchDriveInput,
  touchPedalsFromDelta,
  touchSteerFromDelta,
  type TouchDriveInput,
} from "@/lib/input/touch";
import {
  loadTouchControlMode,
  loadTouchStickSize,
  loadTiltSteerInvert,
  type TouchControlMode,
  type TouchStickSize,
} from "@/lib/input/touchSettings";
import {
  calibrateTilt,
  createTiltCalibration,
  normalizeScreenAngle,
  tiltSteer,
} from "@/lib/input/tilt";

type JoystickMode = "steer" | "pedal";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function Joystick({
  mode,
  inputRef,
  disabled,
  size,
}: {
  mode: JoystickMode;
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled: boolean;
  size: TouchStickSize;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  // Pointer geometry is captured on pointer-down, not read per move: a
  // getBoundingClientRect on every pointermove forces layout at touch rate.
  const geometryRef = useRef({ centerX: 0, centerY: 0, radius: 1 });

  const paint = useCallback((x: number, y: number, value: number) => {
    const knob = knobRef.current;
    if (knob) {
      knob.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
    }
    const base = baseRef.current;
    if (base) {
      base.setAttribute("aria-valuenow", value.toFixed(2));
      base.setAttribute(
        "aria-valuetext",
        mode === "steer"
          ? `${Math.round(value * 100)} percent steering`
          : `${Math.round(Math.max(0, value) * 100)} percent throttle, ${Math.round(Math.max(0, -value) * 100)} percent brake`
      );
    }
  }, [mode]);

  const release = useCallback(() => {
    pointerIdRef.current = null;
    paint(0, 0, 0);
    const input = inputRef.current;
    if (!input) return;
    if (mode === "steer") {
      input.steer = 0;
      input.steeringActive = false;
    } else {
      input.throttle = 0;
      input.brake = 0;
      input.pedalActive = false;
    }
  }, [inputRef, mode, paint]);

  useEffect(() => () => release(), [release]);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const input = inputRef.current;
    if (!input) return;
    const { centerX, centerY, radius } = geometryRef.current;
    const deltaX = clientX - centerX;
    const deltaY = clientY - centerY;
    const visualX = clamp(deltaX, -radius, radius);
    const visualY = mode === "steer" ? 0 : clamp(deltaY, -radius, radius);
    let value = 0;
    if (mode === "steer") {
      input.steeringActive = true;
      input.steer = touchSteerFromDelta(deltaX, radius);
      value = input.steer;
    } else {
      input.pedalActive = true;
      const pedals = touchPedalsFromDelta(deltaY, radius);
      input.throttle = pedals.throttle;
      input.brake = pedals.brake;
      value = pedals.throttle - pedals.brake;
    }
    paint(visualX, visualY, value);
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== null) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.getBoundingClientRect();
    geometryRef.current = {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      radius: Math.max(1, rect.width * 0.34),
    };
    updateFromPointer(event.clientX, event.clientY);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    updateFromPointer(event.clientX, event.clientY);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointerIdRef.current !== event.pointerId) return;
    event.preventDefault();
    release();
  };

  const label = mode === "steer" ? "STEER" : "PEDAL";

  return (
    <div
      ref={baseRef}
      className={`${styles.mobileStick} ${mode === "steer" ? styles.mobileStickSteer : styles.mobileStickPedal} ${disabled ? styles.mobileControlDisabled : ""}`}
      data-size={size}
      role="slider"
      aria-label={mode === "steer" ? "Steering joystick" : "Throttle and brake joystick"}
      aria-orientation={mode === "steer" ? "horizontal" : "vertical"}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={0}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={() => release()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={styles.mobileStickCrosshair} />
      <div ref={knobRef} className={styles.mobileStickKnob} />
      <span className={styles.mobileStickLabel}>{label}</span>
    </div>
  );
}

function HoldButton({
  label,
  inputRef,
  field,
  disabled,
  tone,
}: {
  label: string;
  inputRef: React.RefObject<TouchDriveInput | null>;
  field: "overtake" | "deploy";
  disabled: boolean;
  tone: "red" | "blue";
}) {
  const pointerIdRef = useRef<number | null>(null);
  const release = useCallback(() => {
    pointerIdRef.current = null;
    const input = inputRef.current;
    if (input) input[field] = false;
  }, [field, inputRef]);

  useEffect(() => {
    if (disabled) release();
  }, [disabled, release]);

  return (
    <button
      type="button"
      className={`${styles.mobileActionButton} ${tone === "red" ? styles.mobileActionRed : styles.mobileActionBlue} ${disabled ? styles.mobileControlDisabled : ""}`}
      disabled={disabled}
      aria-label={`${label} hold button`}
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        const input = inputRef.current;
        if (input) input[field] = true;
      }}
      onPointerUp={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        release();
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}

/**
 * The "buttons" steering mode: the left half of the screen is a steering
 * pad, the right half carries pedal pads (roadmap 13).
 *
 * A pad rather than a button per direction on purpose - a left/right pair
 * means the thumb has to travel between two fixed points, while a pad lets it
 * rest where it likes and vary the lock by how far in it presses, which is
 * both easier to modulate and reachable with one thumb while the other is on
 * the pedals.
 */
function SteerPad({
  inputRef,
  disabled,
}: {
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled: boolean;
}) {
  const pointerIdRef = useRef<number | null>(null);
  const geometryRef = useRef({ centerX: 0, halfWidth: 1 });

  const release = useCallback(() => {
    pointerIdRef.current = null;
    const input = inputRef.current;
    if (input) {
      input.steer = 0;
      input.steeringActive = false;
    }
  }, [inputRef]);

  useEffect(() => () => release(), [release]);

  const update = (clientX: number) => {
    const input = inputRef.current;
    if (!input) return;
    const { centerX, halfWidth } = geometryRef.current;
    // Normalized -1..1 across the pad, then shaped by the SAME helper the
    // joystick uses, so the two modes feel identical.
    const normalized = clamp((clientX - centerX) / halfWidth, -1, 1);
    input.steeringActive = true;
    input.steer = touchSteerFromDelta(normalized, 1);
  };

  return (
    <div
      className={`${styles.steerPad} ${disabled ? styles.mobileControlDisabled : ""}`}
      role="slider"
      aria-label="Steering pad"
      aria-orientation="horizontal"
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={0}
      tabIndex={-1}
      onPointerDown={(event) => {
        if (disabled || pointerIdRef.current !== null) return;
        event.preventDefault();
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = event.currentTarget.getBoundingClientRect();
        geometryRef.current = { centerX: rect.left + rect.width / 2, halfWidth: rect.width / 2 };
        update(event.clientX);
      }}
      onPointerMove={(event) => {
        if (disabled || pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        update(event.clientX);
      }}
      onPointerUp={(event) => {
        if (pointerIdRef.current !== event.pointerId) return;
        event.preventDefault();
        release();
      }}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className={styles.steerPadLabel}>STEER PAD</span>
      <span className={styles.steerPadArrowLeft}>◀</span>
      <span className={styles.steerPadArrowRight}>▶</span>
    </div>
  );
}

/** One hold-to-apply pedal pad. A component rather than a closure that calls
 *  hooks, which the rules-of-hooks lint rightly refuses. */
function PedalPad({
  inputRef,
  disabled,
  field,
  label,
}: {
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled: boolean;
  field: "throttle" | "brake";
  label: string;
}) {
  const pointerIdRef = useRef<number | null>(null);
  const release = useCallback(() => {
    pointerIdRef.current = null;
    const input = inputRef.current;
    if (input) {
      input[field] = 0;
      input.pedalActive = false;
    }
  }, [field, inputRef]);
  return (
    <button
      type="button"
      className={`${styles.pedalPad} ${disabled ? styles.mobileControlDisabled : ""}`}
      disabled={disabled}
      aria-label={`${label} pad`}
      onPointerDown={(event) => {
        if (disabled) return;
        event.preventDefault();
        pointerIdRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        const input = inputRef.current;
        if (input) {
          input[field] = 1;
          input.pedalActive = true;
        }
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      {label}
    </button>
  );
}

/** Throttle and brake as two discrete pads, for the buttons mode. */
function PedalPads({
  inputRef,
  disabled,
}: {
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled: boolean;
}) {
  return (
    <div className={styles.pedalPadRow}>
      <PedalPad inputRef={inputRef} disabled={disabled} field="brake" label="BRAKE" />
      <PedalPad inputRef={inputRef} disabled={disabled} field="throttle" label="THROTTLE" />
    </div>
  );
}

export function MobileControls({
  inputRef,
  disabled = false,
  onPause,
  onReplay,
  onToggleSideMirrors,
  sideMirrorsEnabled = true,
}: {
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled?: boolean;
  onPause?: () => void;
  onReplay?: () => void;
  onToggleSideMirrors?: () => void;
  sideMirrorsEnabled?: boolean;
}) {
  // The mode, stick size and tilt inversion all come from persisted settings
  // (see app/race/TouchControlSettings.tsx) rather than from controls on the
  // deck, which is hidden in landscape phone play.
  const [stickSize] = useState<TouchStickSize>(() => loadTouchStickSize());
  const [controlMode, setControlMode] = useState<TouchControlMode>(() => loadTouchControlMode());
  const tiltInvertRef = useRef(loadTiltSteerInvert());

  // Follow a change made in the pause menu while this deck is mounted, so the
  // sticks/pads swap without needing a reload.
  useEffect(() => {
    const sync = () => setControlMode(loadTouchControlMode());
    window.addEventListener("lift-and-coast:touch-control-mode", sync);
    window.addEventListener("lift-and-coast:settings-changed", sync);
    return () => {
      window.removeEventListener("lift-and-coast:touch-control-mode", sync);
      window.removeEventListener("lift-and-coast:settings-changed", sync);
    };
  }, []);

  // The orientation listener. Reads the calibration object the settings panel
  // shares, so pressing RECENTRE there re-zeroes the control that is actually
  // running here.
  useEffect(() => {
    if (controlMode !== "tilt" || disabled) return;
    if (typeof window === "undefined") return;
    const calibration = createTiltCalibration();
    const onOrientation = (event: DeviceOrientationEvent) => {
      if (event.gamma === null && event.beta === null) return;
      const input = inputRef.current;
      if (!input) return;
      const angle = normalizeScreenAngle(
        typeof screen !== "undefined" && screen.orientation ? screen.orientation.angle : 0
      );
      if (!calibration.calibrated) {
        // Auto-calibrate from the first real reading, so the mode works even
        // if the player skipped the RECENTRE button.
        calibrateTilt(calibration, { gamma: event.gamma ?? 0, beta: event.beta ?? 0 }, angle);
        input.steer = 0;
        input.steeringActive = true;
        return;
      }
      input.steeringActive = true;
      input.steer = tiltSteer(calibration, { gamma: event.gamma ?? 0, beta: event.beta ?? 0 }, angle, {
        invert: tiltInvertRef.current,
      });
    };
    window.addEventListener("deviceorientation", onOrientation);
    // Captured here, not read in the cleanup: the ref's current value is
    // whatever the latest render put there, and a teardown that reads it late
    // can miss the very input object it is meant to release.
    const held = inputRef.current;
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      if (held) {
        held.steer = 0;
        held.steeringActive = false;
      }
    };
  }, [controlMode, disabled, inputRef]);

  useEffect(() => {
    if (disabled) resetTouchDriveInput(inputRef.current);
  }, [disabled, inputRef]);

  useEffect(() => {
    const reset = () => resetTouchDriveInput(inputRef.current);
    window.addEventListener("blur", reset);
    window.addEventListener("resize", reset);
    document.addEventListener("visibilitychange", reset);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", reset);
      reset();
    };
  }, [inputRef]);

  return (
    <section className={`${styles.mobileControls} ${disabled ? styles.mobileControlsDisabled : ""}`} aria-label="Touch driving controls">
      {/*
        The header is intentionally NOT rendered in landscape phone play: the
        existing `pointer: coarse` rule in race.module.css hides it because it
        sat on top of the race HUD, and the spec wants only Pause and
        Overtake/ERS on screen while driving. The steering-mode choice, the
        stick size and the iOS tilt permission all live in the pause menu
        instead - see app/race/TouchControlSettings.tsx.
      */}
      {controlMode === "tilt" && (
        <div className={styles.tiltBar}>
          <span>TILT · TILT TO STEER</span>
          <button
            type="button"
            className={styles.touchSizeButton}
            aria-label="Recalibrate tilt neutral"
            onClick={() => {
              const w = window as unknown as { __liftRecalibrateTilt?: () => void };
              w.__liftRecalibrateTilt?.();
            }}
          >
            RECENTRE
          </button>
        </div>
      )}
      <div className={styles.mobileStickRow}>
        {/*
          STEERING ON THE LEFT THUMB, PEDALS ON THE RIGHT. This is what every
          mobile racer does and it is the opposite of what this deck used to
          do - the two joysticks were the wrong way round, so a player had to
          cross their hands to turn into a corner. The order below is the
          fix, not a preference.
        */}
        {controlMode !== "buttons" && (
          <Joystick mode="steer" inputRef={inputRef} disabled={disabled} size={stickSize} />
        )}
        {controlMode === "buttons" ? (
          <SteerPad inputRef={inputRef} disabled={disabled} />
        ) : (
          <div className={styles.mobileControlHint}>
            <strong>STEER</strong>
            <span>LEFT / RIGHT</span>
            <strong>PEDAL</strong>
            <span>UP THROTTLE / DOWN BRAKE</span>
          </div>
        )}
        {controlMode === "buttons" ? (
          <PedalPads inputRef={inputRef} disabled={disabled} />
        ) : (
          controlMode !== "tilt" && (
            <Joystick mode="pedal" inputRef={inputRef} disabled={disabled} size={stickSize} />
          )
        )}
      </div>
      <div className={styles.mobileActionRow}>
        <HoldButton label="OVERTAKE" field="overtake" inputRef={inputRef} disabled={disabled} tone="red" />
        <HoldButton label="ERS" field="deploy" inputRef={inputRef} disabled={disabled} tone="blue" />
        {onReplay && (
          <button type="button" className={styles.mobileActionButton} disabled={disabled} onClick={onReplay}>
            REPLAY
          </button>
        )}
        {onToggleSideMirrors && (
          <button
            type="button"
            className={`${styles.mobileActionButton} ${styles.mobileActionBlue} ${sideMirrorsEnabled ? styles.mobileActionActive : ""}`}
            disabled={false}
            aria-pressed={sideMirrorsEnabled}
            onClick={onToggleSideMirrors}
          >
            MIRRORS
          </button>
        )}
        {onPause && (
          <button type="button" className={`${styles.mobileActionButton} ${styles.mobileActionPause}`} disabled={disabled} onClick={onPause}>
            PAUSE
          </button>
        )}
      </div>
    </section>
  );
}
