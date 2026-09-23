"use client";

import { useEffect, useState } from "react";
import styles from "./race.module.css";
import type { RaceOpsCommand, RaceOpsSnapshot } from "@/lib/race/raceOps";
import type { TelemetryFrame } from "@/lib/race/replay";
import { weatherLabel } from "@/lib/physics/weather";
import { drsSummary } from "@/lib/physics/drs";
import { strategySummary } from "@/lib/race/strategy";
import { raceControlSummary } from "@/lib/race/raceControl";
import type { EnergyMode } from "@/lib/physics/energy";
import type { StrategyMode } from "@/lib/race/strategy";
import type { TireCompoundId } from "@/lib/physics/tireModel";

function send(commandRef: React.RefObject<RaceOpsCommand[]>, command: RaceOpsCommand) {
  commandRef.current.push(command);
}

function TelemetryInputs({ sample }: { sample: TelemetryFrame | undefined }) {
  if (!sample) return null;
  return (
    <div className={styles.opsInputs} aria-label="Live driver inputs">
      <span>THR <i style={{ width: `${Math.round(sample.throttle * 100)}%` }} /></span>
      <span>BRK <i style={{ width: `${Math.round(sample.brake * 100)}%` }} /></span>
      <span>STR <i style={{ width: `${Math.round(Math.abs(sample.steer) * 100)}%` }} /></span>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return <div className={styles.opsSparklineEmpty}>TELEMETRY BUFFERING</div>;
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${30 - Math.max(0, Math.min(30, value * 30))}`)
    .join(" ");
  return (
    <svg className={styles.opsSparkline} viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Speed telemetry trace">
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function RaceOpsPanel({
  commandRef,
  snapshotRef,
}: {
  commandRef: React.RefObject<RaceOpsCommand[]>;
  snapshotRef: React.RefObject<RaceOpsSnapshot | null>;
}) {
  const [snapshot, setSnapshot] = useState<RaceOpsSnapshot | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const refresh = () => {
      const next = snapshotRef.current;
      if (next) setSnapshot({ ...next });
    };
    refresh();
    const id = window.setInterval(refresh, 120);
    return () => window.clearInterval(id);
  }, [snapshotRef]);

  if (!snapshot) return null;
  const latestTelemetry = snapshot.telemetry[snapshot.telemetry.length - 1];
  const speedTrace = snapshot.telemetry.slice(-80).map((sample) => Math.abs(sample.speedMs) / 100);
  const ersModes: EnergyMode[] = ["harvest", "balanced", "attack"];
  const strategyModes: StrategyMode[] = ["save", "balanced", "push"];
  const compounds: TireCompoundId[] = ["soft", "medium", "hard"];

  return (
    <section className={styles.raceOpsPanel} aria-label="Race operations">
      <button type="button" className={styles.raceOpsHeader} onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}>
        <span>RACE OPS</span><span>{collapsed ? "+" : "−"}</span>
      </button>
      {!collapsed && (
        <div className={styles.raceOpsBody}>
          <div className={styles.opsStatus}>
            <strong>{weatherLabel(snapshot.weather.preset)}</strong>
            <span>{snapshot.weather.trackTemperatureC.toFixed(0)}° TRACK</span>
            <span>GRIP {Math.round(snapshot.weather.gripMultiplier * 100)}%</span>
            <span>TIRE {snapshot.strategy.tireTemperatureC.toFixed(0)}°C</span>
            <span>BLANKET {snapshot.strategy.blanketFitted ? `${snapshot.strategy.blanketTemperatureC.toFixed(0)}°C` : "OFF"}</span>
          </div>
          <div className={styles.opsGroup}>
            <span className={styles.opsLabel}>WEATHER</span>
            <div className={styles.opsButtons}>
              {(["clear", "cloudy", "rain"] as const).map((preset) => (
                <button key={preset} type="button" className={snapshot.weather.preset === preset ? styles.opsButtonActive : styles.opsButton} onClick={() => send(commandRef, { type: "set-weather", preset })}>
                  {preset.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.opsGroup}>
            <span className={styles.opsLabel}>ERS · {Math.round(snapshot.batteryFraction * 100)}% · LAP {Math.round(snapshot.deploymentBudgetFraction * 100)}%</span>
            <div className={styles.opsButtons}>
              {ersModes.map((mode) => (
                <button key={mode} type="button" className={snapshot.energyMode === mode ? styles.opsButtonActive : styles.opsButton} onClick={() => send(commandRef, { type: "set-ers-mode", mode })}>
                  {mode.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.opsGroup}>
            <span className={styles.opsLabel}>STRATEGY · {strategySummary(snapshot.strategy)}</span>
            <div className={styles.opsButtons}>
              {strategyModes.map((mode) => (
                <button key={mode} type="button" className={snapshot.strategy.mode === mode ? styles.opsButtonActive : styles.opsButton} onClick={() => send(commandRef, { type: "set-strategy-mode", mode })}>
                  {mode.toUpperCase()}
                </button>
              ))}
              {compounds.map((compound) => (
                <button key={compound} type="button" className={snapshot.strategy.compound === compound ? styles.opsButtonActive : styles.opsButton} onClick={() => send(commandRef, { type: "set-compound", compound })}>
                  {compound[0].toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className={styles.opsButtons}>
            <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: snapshot.strategy.pitPhase === "requested" ? "cancel-pit" : "request-pit" })}>{snapshot.strategy.pitPhase === "requested" ? "CANCEL PIT" : "PIT STOP"}</button>
            <button type="button" className={snapshot.drs.requested ? styles.opsButtonActive : styles.opsAction} onClick={() => send(commandRef, { type: "toggle-drs" })}>{drsSummary(snapshot.drs)}</button>
            {snapshot.replay.playback ? (
              <>
                <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "seek-replay", seconds: -5 })}>-5s</button>
                <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "toggle-replay" })}>PAUSE</button>
                <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "seek-replay", seconds: 5 })}>+5s</button>
                <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "stop-replay" })}>EXIT</button>
              </>
            ) : (
              <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "toggle-replay" })}>INSTANT REPLAY</button>
            )}
            <button type="button" className={styles.opsAction} onClick={() => send(commandRef, { type: "report-unsafe-rejoin" })}>REPORT REJOIN</button>
          </div>
          <div className={styles.opsStatus}>
            <span>CONTROL {raceControlSummary(snapshot.raceControl)}</span>
            <span>{snapshot.raceControl.lastDecision?.message ?? "NO STEWARD DECISIONS"}</span>
            <span>{snapshot.replay.playback ? `REPLAY ${snapshot.replay.cursorSeconds.toFixed(1)}s` : "REPLAY READY"}</span>
          </div>
          <TelemetryInputs sample={latestTelemetry} />
          <Sparkline values={speedTrace} color="#f2f4f7" />
          <div className={styles.opsHint}>X DRS · O PIT · P REPLAY · SHIFT ERS DEPLOY</div>
        </div>
      )}
    </section>
  );
}
