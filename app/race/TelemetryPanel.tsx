"use client";

import { useEffect, useRef } from "react";
import styles from "./race.module.css";
import { STATIC_WHEEL_LOAD_N } from "@/lib/physics/vehicle";
import {
  GG_PLOT_MAX_G,
  WHEEL_GRID_POSITION,
  WHEEL_ORDER,
  balanceBias,
  balanceLabel,
  formatG,
  formatLoad,
  formatTemp,
  frontLoadPercent,
  ggPlotPoint,
  gripBarFill,
  loadBarFill,
  type TelemetrySample,
  type WheelCorner,
} from "@/lib/race/telemetry";

/**
 * Live telemetry overlay (in-race engineer view).
 *
 * The bottom bar already carries gear, speed, RPM, ERS, driver inputs, sector
 * times, tyre compound, assists and damage, so this panel deliberately shows
 * the layer underneath it: how load is distributed across the four corners,
 * how much grip each corner actually has, whether it is on the ground, and
 * the combined-g trace that makes a balance problem visible at a glance.
 *
 * The car writes a plain sample into a ref every render frame (see Car.tsx)
 * rather than this component reaching into the physics world, so the panel is
 * a pure renderer and the plumbing stays one-directional. It animates itself
 * on its own rAF so the readouts do not depend on the parent's re-render
 * cadence, and reads the ref each frame instead of holding React state - a
 * 60Hz setState here would re-render the HUD for no reason.
 */

/** How many g-g samples the trace holds. At 60Hz this is about 5 seconds. */
const GG_TRACE_SAMPLES = 300;

const CORNER_LABELS: Record<WheelCorner, string> = {
  frontLeft: "FL",
  frontRight: "FR",
  rearLeft: "RL",
  rearRight: "RR",
};

interface WheelCells {
  load: HTMLSpanElement | null;
  grip: HTMLSpanElement | null;
  temp: HTMLSpanElement | null;
  loadBar: HTMLDivElement | null;
  gripBar: HTMLDivElement | null;
  box: HTMLDivElement | null;
}

interface TelemetryCells {
  gLat: HTMLSpanElement | null;
  gLong: HTMLSpanElement | null;
  balance: HTMLSpanElement | null;
  frontPct: HTMLSpanElement | null;
  slip: HTMLSpanElement | null;
  yaw: HTMLSpanElement | null;
  wheel: Record<WheelCorner, WheelCells>;
}

function emptyCells(): TelemetryCells {
  const wheel = {} as Record<WheelCorner, WheelCells>;
  for (const corner of WHEEL_ORDER) {
    wheel[corner] = { load: null, grip: null, temp: null, loadBar: null, gripBar: null, box: null };
  }
  return { gLat: null, gLong: null, balance: null, frontPct: null, slip: null, yaw: null, wheel };
}

export function TelemetryPanel({ sampleRef }: { sampleRef: React.RefObject<TelemetrySample | null> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const ggRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<{ x: number; y: number }[]>([]);
  // Mutable mirrors of the nodes the frame loop writes into. Deliberately not
  // React state: these change every frame, and a setState per frame would
  // re-render the whole HUD for no reason.
  const cellsRef = useRef<TelemetryCells>(emptyCells());

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const cells = cellsRef.current;
      const canvas = ggRef.current;
      const sample = sampleRef.current;
      if (cells && sample) {
        cells.gLat!.textContent = formatG(sample.lateralG);
        cells.gLong!.textContent = formatG(sample.longitudinalG);
        cells.slip!.textContent = `${sample.slipAngleDeg.toFixed(1)}°`;
        cells.yaw!.textContent = `${sample.yawRateDegS.toFixed(0)}°/s`;
        const bias = balanceBias(sample);
        cells.balance!.textContent = balanceLabel(bias);
        // The balance bar is a centre-zero meter: full left understeer, full
        // right oversteer, so a driver can see the magnitude and not just
        // read a word.
        cells.balance!.style.transform = `translateX(${(bias * 50).toFixed(1)}%)`;
        cells.frontPct!.textContent = `${frontLoadPercent(sample).toFixed(0)}%`;

        for (const corner of WHEEL_ORDER) {
          const cell = cells.wheel[corner];
          const w = sample.wheels[corner];
          cell.load!.textContent = formatLoad(w.loadN);
          cell.grip!.textContent = w.grip.toFixed(2);
          cell.temp!.textContent = formatTemp(w.temperatureC);
          cell.loadBar!.style.width = `${(loadBarFill(w.loadN, STATIC_WHEEL_LOAD_N) * 100).toFixed(1)}%`;
          cell.gripBar!.style.width = `${(gripBarFill(w.grip) * 100).toFixed(1)}%`;
          // A corner off the ground is the single most useful thing this
          // panel can say, so it changes the box, not just a bar.
          cell.box!.dataset.contact = w.inContact ? "on" : "off";
        }

        if (canvas) {
          const point = ggPlotPoint(sample.lateralG, sample.longitudinalG);
          traceRef.current.push(point);
          if (traceRef.current.length > GG_TRACE_SAMPLES) traceRef.current.shift();
          drawTrace(canvas, traceRef.current);
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [sampleRef]);

  const cells = cellsRef.current;

  return (
    <div ref={rootRef} className={styles.telemetryPanel} data-testid="telemetry-panel">
      <div className={styles.telemetryHeader}>
        <span className={styles.telemetryTitle}>TELEMETRY</span>
        <span className={styles.telemetryHint}>4</span>
      </div>

      <div className={styles.telemetryBody}>
        <div className={styles.telemetryCarMap}>
          {WHEEL_ORDER.map((corner) => {
            const [col, row] = WHEEL_GRID_POSITION[corner];
            const cell = cells.wheel[corner];
            return (
              <div
                key={corner}
                ref={(node) => {
                  cell.box = node;
                }}
                className={styles.telemetryWheel}
                data-contact="on"
                style={{ gridColumn: col + 1, gridRow: row + 1 }}
              >
                <span className={styles.telemetryWheelName}>{CORNER_LABELS[corner]}</span>
                <div className={styles.telemetryBarTrack}>
                  <div
                    ref={(node) => {
                      cell.loadBar = node;
                    }}
                    className={styles.telemetryBarLoad}
                  />
                </div>
                <div className={styles.telemetryBarTrack}>
                  <div
                    ref={(node) => {
                      cell.gripBar = node;
                    }}
                    className={styles.telemetryBarGrip}
                  />
                </div>
                <span
                  ref={(node) => {
                    cell.load = node;
                  }}
                  className={styles.telemetryWheelLoad}
                >
                  0.0kN
                </span>
                <span
                  ref={(node) => {
                    cell.grip = node;
                  }}
                  className={styles.telemetryWheelGrip}
                >
                  0.00
                </span>
                <span
                  ref={(node) => {
                    cell.temp = node;
                  }}
                  className={styles.telemetryWheelTemp}
                >
                  --
                </span>
              </div>
            );
          })}
        </div>

        <div className={styles.telemetrySide}>
          <div className={styles.telemetryRow}>
            <span className={styles.telemetryLabel}>LAT G</span>
            <span
              ref={(node) => {
                cells.gLat = node;
              }}
              className={styles.telemetryValue}
            >
              +0.0
            </span>
          </div>
          <div className={styles.telemetryRow}>
            <span className={styles.telemetryLabel}>LON G</span>
            <span
              ref={(node) => {
                cells.gLong = node;
              }}
              className={styles.telemetryValue}
            >
              +0.0
            </span>
          </div>
          <div className={styles.telemetryRow}>
            <span className={styles.telemetryLabel}>SLIP</span>
            <span
              ref={(node) => {
                cells.slip = node;
              }}
              className={styles.telemetryValue}
            >
              0.0°
            </span>
          </div>
          <div className={styles.telemetryRow}>
            <span className={styles.telemetryLabel}>YAW</span>
            <span
              ref={(node) => {
                cells.yaw = node;
              }}
              className={styles.telemetryValue}
            >
              0°/s
            </span>
          </div>
          <div className={styles.telemetryRow}>
            <span className={styles.telemetryLabel}>FRONT</span>
            <span
              ref={(node) => {
                cells.frontPct = node;
              }}
              className={styles.telemetryValue}
            >
              50%
            </span>
          </div>
        </div>

        <div className={styles.telemetryBalance}>
          <div className={styles.telemetryBalanceTrack}>
            <div className={styles.telemetryBalanceNeedle} />
          </div>
          <div className={styles.telemetryBalanceLabels}>
            <span>UNDERSTEER</span>
            <span>OVERSTEER</span>
          </div>
          <div className={styles.telemetryBalanceValue}>
            <span
              ref={(node) => {
                cells.balance = node;
              }}
            >
              NEUTRAL
            </span>
          </div>
        </div>

        <div className={styles.telemetryGg}>
          <canvas ref={ggRef} width={132} height={132} aria-label="Combined g trace" />
          <span className={styles.telemetryGgLabel}>G-G {GG_PLOT_MAX_G}g</span>
        </div>
      </div>
    </div>
  );
}

/** Draws the combined-g trace: a ring grid for the g limits and the fading
 *  recent path, oldest faintest. */
function drawTrace(canvas: HTMLCanvasElement, trace: { x: number; y: number }[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const half = size / 2;
  const radius = half - 12;
  ctx.clearRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.lineWidth = 1;
  for (const fraction of [0.5, 1]) {
    ctx.beginPath();
    ctx.arc(half, half, radius * fraction, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(half - radius, half);
  ctx.lineTo(half + radius, half);
  ctx.moveTo(half, half - radius);
  ctx.lineTo(half, half + radius);
  ctx.stroke();

  if (trace.length < 2) return;
  // Oldest samples fade out, so the eye reads direction of travel without a
  // separate legend.
  for (let i = 1; i < trace.length; i++) {
    const age = i / trace.length;
    ctx.strokeStyle = `rgba(57, 255, 136, ${(0.12 + age * 0.78).toFixed(3)})`;
    ctx.lineWidth = 1 + age * 1.6;
    ctx.beginPath();
    ctx.moveTo(half + trace[i - 1].x * radius, half - trace[i - 1].y * radius);
    ctx.lineTo(half + trace[i].x * radius, half - trace[i].y * radius);
    ctx.stroke();
  }
  // The live sample, as a filled dot.
  const last = trace[trace.length - 1];
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(half + last.x * radius, half - last.y * radius, 2.6, 0, Math.PI * 2);
  ctx.fill();
}
