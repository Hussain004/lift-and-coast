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
  loadTouchStickSize,
  saveTouchStickSize,
  TOUCH_STICK_SIZE_OPTIONS,
  type TouchStickSize,
} from "@/lib/input/touchSettings";

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
  const [stickSize, setStickSize] = useState<TouchStickSize>(() => loadTouchStickSize());

  const changeStickSize = (next: TouchStickSize) => {
    setStickSize(next);
    saveTouchStickSize(next);
  };

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
      <div className={styles.mobileControlsHeader}>
        <span>TOUCH DRIVE</span>
        <div className={styles.touchSizeSetting} role="group" aria-label="Joystick size">
          <span>STICK SIZE</span>
          {TOUCH_STICK_SIZE_OPTIONS.map((option) => (
            <button
              type="button"
              key={option}
              className={`${styles.touchSizeButton} ${stickSize === option ? styles.touchSizeButtonActive : ""}`}
              aria-label={`${option} joystick size`}
              aria-pressed={stickSize === option}
              onClick={() => changeStickSize(option)}
            >
              {option === "small" ? "S" : option === "medium" ? "M" : "L"}
            </button>
          ))}
        </div>
      </div>
      <div className={styles.mobileStickRow}>
        <Joystick mode="pedal" inputRef={inputRef} disabled={disabled} size={stickSize} />
        <div className={styles.mobileControlHint}>
          <strong>PEDAL</strong>
          <span>UP THROTTLE / DOWN BRAKE</span>
          <strong>STEER</strong>
          <span>LEFT / RIGHT</span>
        </div>
        <Joystick mode="steer" inputRef={inputRef} disabled={disabled} size={stickSize} />
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
