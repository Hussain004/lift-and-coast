"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./race.module.css";
import {
  resetTouchDriveInput,
  touchPedalsFromDelta,
  touchSteerFromDelta,
  type TouchDriveInput,
} from "@/lib/input/touch";

type JoystickMode = "steer" | "pedal";

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function Joystick({
  mode,
  inputRef,
  disabled,
}: {
  mode: JoystickMode;
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled: boolean;
}) {
  const baseRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [stick, setStick] = useState({ x: 0, y: 0, value: 0 });

  const release = useCallback((updateVisual = true) => {
    pointerIdRef.current = null;
    if (updateVisual) setStick({ x: 0, y: 0, value: 0 });
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
  }, [inputRef, mode]);

  useEffect(() => () => release(false), [release]);

  const updateFromPointer = (clientX: number, clientY: number) => {
    const base = baseRef.current;
    const input = inputRef.current;
    if (!base || !input) return;
    const rect = base.getBoundingClientRect();
    const radius = Math.max(1, rect.width * 0.34);
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
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
    setStick({ x: visualX, y: visualY, value });
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerIdRef.current !== null) return;
    event.preventDefault();
    pointerIdRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
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

  const value = stick.value;
  const label = mode === "steer" ? "STEER" : "PEDAL";

  return (
    <div
      ref={baseRef}
      className={`${styles.mobileStick} ${mode === "steer" ? styles.mobileStickSteer : styles.mobileStickPedal} ${disabled ? styles.mobileControlDisabled : ""}`}
      role="slider"
      aria-label={mode === "steer" ? "Steering joystick" : "Throttle and brake joystick"}
      aria-orientation={mode === "steer" ? "horizontal" : "vertical"}
      aria-valuemin={-1}
      aria-valuemax={1}
      aria-valuenow={Number(value.toFixed(2))}
      aria-valuetext={mode === "steer" ? `${Math.round(value * 100)} percent steering` : `${Math.round(Math.max(0, value) * 100)} percent throttle, ${Math.round(Math.max(0, -value) * 100)} percent brake`}
      tabIndex={-1}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={() => release()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={styles.mobileStickCrosshair} />
      <div
        className={styles.mobileStickKnob}
        style={{ transform: `translate(calc(-50% + ${stick.x}px), calc(-50% + ${stick.y}px))` }}
      />
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
}: {
  inputRef: React.RefObject<TouchDriveInput | null>;
  disabled?: boolean;
  onPause?: () => void;
  onReplay?: () => void;
}) {
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
        <span>PORTRAIT DECK / LANDSCAPE OVERLAY</span>
      </div>
      <div className={styles.mobileStickRow}>
        <Joystick mode="steer" inputRef={inputRef} disabled={disabled} />
        <div className={styles.mobileControlHint}>
          <strong>STEER</strong>
          <span>LEFT / RIGHT</span>
          <strong>PEDAL</strong>
          <span>UP THROTTLE / DOWN BRAKE</span>
        </div>
        <Joystick mode="pedal" inputRef={inputRef} disabled={disabled} />
      </div>
      <div className={styles.mobileActionRow}>
        <HoldButton label="OVERTAKE" field="overtake" inputRef={inputRef} disabled={disabled} tone="red" />
        <HoldButton label="ERS" field="deploy" inputRef={inputRef} disabled={disabled} tone="blue" />
        {onReplay && (
          <button type="button" className={styles.mobileActionButton} disabled={disabled} onClick={onReplay}>
            REPLAY
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
