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
 * Live telemetry overlay - the engineer's view, toggled with 4 (or cycled to
 * with H).
 *
 * It shares the right-hand HUD slot with the controls reference and Race Ops,
 * so exactly one of the three is mounted and none can collide with the mirror
 * above them.
 *
 * What it shows is chosen to be what the bottom bar does NOT already show.
 * That bar carries gear, speed, RPM, ERS, driver inputs, sector times, tyre
 * compound, assists and damage; this adds the layer underneath: how load is
 * distributed across the four corners, how much grip each actually has,
 * whether it is on the ground, and the combined-g trace that makes a balance
 * problem visible.
 *
 * The car writes a plain sample into a ref every physics step (see Car.tsx)
 * and this component reads that ref on its own rAF, so the values never pass
 * through React state - a setState per frame would re-render the whole HUD.
 * The formatting and scaling all live in lib/race/telemetry.ts, which is pure
 * and unit-tested; this is a renderer.
 */

/** G-g samples retained. At 60Hz that is about five seconds of trace. */
const GG_TRACE_SAMPLES = 300;
const GG_CANVAS_PX = 248;

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
  balanceNeedle: HTMLDivElement | null;
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
  return {
    gLat: null,
    gLong: null,
    balance: null,
    balanceNeedle: null,
    frontPct: null,
    slip: null,
    yaw: null,
    wheel,
  };
}

export function TelemetryPanel({ sampleRef }: { sampleRef: React.RefObject<TelemetrySample | null> }) {
  const ggRef = useRef<HTMLCanvasElement>(null);
  const traceRef = useRef<{ x: number; y: number }[]>([]);
  const cellsRef = useRef<TelemetryCells>(emptyCells());

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const cells = cellsRef.current;
      const sample = sampleRef.current;
      if (cells && sample) {
        cells.gLat!.textContent = formatG(sample.lateralG);
        cells.gLong!.textContent = formatG(sample.longitudinalG);
        cells.slip!.textContent = `${sample.slipAngleDeg.toFixed(1)}°`;
        cells.yaw!.textContent = `${sample.yawRateDegS.toFixed(0)}°/s`;
        cells.frontPct!.textContent = `${frontLoadPercent(sample).toFixed(0)}%`;

        const bias = balanceBias(sample);
        cells.balance!.textContent = balanceLabel(bias);
        // The needle is a centre-zero meter: full left understeer, full right
        // oversteer, so the magnitude reads and not just the word.
        cells.balanceNeedle!.style.transform = `translateX(${(bias * 50).toFixed(1)}%)`;

        for (const corner of WHEEL_ORDER) {
          const cell = cells.wheel[corner];
          const w = sample.wheels[corner];
          cell.load!.textContent = formatLoad(w.loadN);
          cell.grip!.textContent = w.grip.toFixed(2);
          cell.temp!.textContent = formatTemp(w.temperatureC);
          cell.loadBar!.style.width = `${(loadBarFill(w.loadN, STATIC_WHEEL_LOAD_N) * 100).toFixed(1)}%`;
          cell.gripBar!.style.width = `${(gripBarFill(w.grip) * 100).toFixed(1)}%`;
          cell.box!.dataset.contact = w.inContact ? "on" : "off";
        }

        const canvas = ggRef.current;
        if (canvas) {
          const point = ggPlotPoint(sample.lateralG, sample.longitudinalG);
          traceRef.current.push(point);
          if (traceRef.current.length > GG_TRACE_SAMPLES) traceRef.current.shift();
          drawTrace(canvas, traceRef.current);
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [sampleRef]);

  const cells = cellsRef.current;

  return (
    <div className={styles.telemetryPanel} data-testid="telemetry-panel">
      <div className={styles.telemetryHeader}>
        <span className={styles.telemetryTitle}>TELEMETRY</span>
        <span className={styles.telemetryHint}>4 to close</span>
      </div>

      <div className={styles.telemetryBody}>
        <div className={styles.telemetryCarMap}>
          {WHEEL_ORDER.map((corner) => {
            const [column, row] = WHEEL_GRID_POSITION[corner];
            const cell = cells.wheel[corner];
            return (
              <div
                key={corner}
                ref={(node) => {
                  cell.box = node;
                }}
                className={styles.telemetryWheel}
                data-contact="on"
                style={{ gridColumn: column + 1, gridRow: row + 1 }}
              >
                <div className={styles.telemetryWheelTop}>
                  <span className={styles.telemetryWheelName}>{CORNER_LABELS[corner]}</span>
                  <span
                    ref={(node) => {
                      cell.temp = node;
                    }}
                    className={styles.telemetryWheelTemp}
                  >
                    --
                  </span>
                </div>
                <div className={styles.telemetryWheelBars}>
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
                </div>
                <div className={styles.telemetryWheelValues}>
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
                </div>
              </div>
            );
          })}
        </div>

        <dl className={styles.telemetryReadouts}>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>LATERAL</dt>
            <dd
              ref={(node) => {
                cells.gLat = node;
              }}
              className={styles.telemetryValue}
            >
              +0.0
            </dd>
          </div>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>LONGITUDINAL</dt>
            <dd
              ref={(node) => {
                cells.gLong = node;
              }}
              className={styles.telemetryValue}
            >
              +0.0
            </dd>
          </div>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>SLIP ANGLE</dt>
            <dd
              ref={(node) => {
                cells.slip = node;
              }}
              className={styles.telemetryValue}
            >
              0.0°
            </dd>
          </div>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>YAW RATE</dt>
            <dd
              ref={(node) => {
                cells.yaw = node;
              }}
              className={styles.telemetryValue}
            >
              0°/s
            </dd>
          </div>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>FRONT LOAD</dt>
            <dd
              ref={(node) => {
                cells.frontPct = node;
              }}
              className={styles.telemetryValue}
            >
              50%
            </dd>
          </div>
          <div className={styles.telemetryRow}>
            <dt className={styles.telemetryLabel}>BALANCE</dt>
            <dd className={styles.telemetryValue}>
              <span
                ref={(node) => {
                  cells.balance = node;
                }}
              >
                NEUTRAL
              </span>
              <div className={styles.telemetryBalanceTrack}>
                <div
                  ref={(node) => {
                    cells.balanceNeedle = node;
                  }}
                  className={styles.telemetryBalanceNeedle}
                />
              </div>
            </dd>
          </div>
        </dl>

        <div className={styles.telemetryGg}>
          <canvas
            ref={ggRef}
            width={GG_CANVAS_PX}
            height={GG_CANVAS_PX}
            aria-label="Combined g trace"
          />
          <span className={styles.telemetryGgLabel}>COMBINED G · {GG_PLOT_MAX_G}G</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Draws the combined-g trace: concentric rings at half and full g, a crosshair
 * for the axes, then the recent path fading with age so the eye reads
 * direction of travel without a separate legend, and a dot on the live sample.
 */
function drawTrace(canvas: HTMLCanvasElement, trace: { x: number; y: number }[]): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const size = canvas.width;
  const half = size / 2;
  const radius = half - 10;
  ctx.clearRect(0, 0, size, size);

  ctx.strokeStyle = "rgba(255,255,255,0.10)";
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
  for (let i = 1; i < trace.length; i++) {
    const age = i / trace.length;
    ctx.strokeStyle = `rgba(127, 220, 164, ${(0.10 + age * 0.75).toFixed(3)})`;
    ctx.lineWidth = 1 + age * 1.8;
    ctx.beginPath();
    ctx.moveTo(half + trace[i - 1].x * radius, half - trace[i - 1].y * radius);
    ctx.lineTo(half + trace[i].x * radius, half - trace[i].y * radius);
    ctx.stroke();
  }
  const last = trace[trace.length - 1];
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(half + last.x * radius, half - last.y * radius, 3, 0, Math.PI * 2);
  ctx.fill();
}
