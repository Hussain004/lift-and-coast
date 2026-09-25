// The inexpensive geometry gate runs with the normal suite. The full
// standing-start sweep is opt-in because it drives every real trimesh twice:
// `npm run diagnose:ace`.
import { describe, expect, it } from "vitest";
import { getLineRoom, getRacingLine } from "../lib/tracks/racingLineCache";
import { computeRacingLine } from "../lib/tracks/racingLine";
import {
  analyzeRacingLine,
  RACING_LINE_ACCELERATION_LIMIT,
  RACING_LINE_DECELERATION_LIMIT,
} from "../lib/tracks/racingLineQuality";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { runStandingStartLap } from "./helpers/aceBenchmark";

const MAX_OFF_TRACK_METERS = 6;
const FLIP_THRESHOLD_RAD = 0.6;
const runDetailedBenchmark = process.env.ACE_BENCHMARK === "1" ? it : it.skip;

describe("all-track Pro/Ace racing-line profiles", () => {
  it("keeps synthetic/unregistered tracks on the conservative Pro/Ace fallback", () => {
    const synthetic = { ...getTrack("spa"), id: "synthetic-ace-track" };
    const proLine = computeRacingLine(synthetic, "pro");
    const aceLine = computeRacingLine(synthetic, "ace");
    expect(proLine[0].steeringMode).toBe("pure-pursuit");
    expect(aceLine[0].steeringMode).toBe("pure-pursuit");
    expect(proLine[0].steeringMaxPace).toBe(1.08);
    expect(aceLine[0].steeringMaxPace).toBe(1.08);
  });

  it("keeps Suzuka's default line on the bridge-safe acceleration ceiling", () => {
    const suzuka = getTrack("suzuka");
    const quality = analyzeRacingLine(suzuka, getRacingLine(suzuka, "default"));
    expect(quality.maximumRequiredAcceleration).toBeLessThanOrEqual(8.05);
  });

  it("keeps every registered default, Pro, and Ace line finite and feasible", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const defaultLine = getRacingLine(track, "default");
      const proLine = getRacingLine(track, "pro");
      const aceLine = getRacingLine(track, "ace");
      const defaultQuality = analyzeRacingLine(track, defaultLine);
      const proQuality = analyzeRacingLine(track, proLine);
      const aceQuality = analyzeRacingLine(track, aceLine);
      const proRoom = getLineRoom(track, "pro");
      const aceRoom = getLineRoom(track, "ace");

      for (const [profile, line, quality] of [
        ["pro", proLine, proQuality],
        ["ace", aceLine, aceQuality],
      ] as const) {
        // Keep the acceptance bound independent from the production tuning
        // helper: a raised implementation limit must not raise the gate.
        const accelerationLimit =
          meta.id === "suzuka" ? 8 : meta.id === "spielberg" ? 11 : RACING_LINE_ACCELERATION_LIMIT;
        expect(line.length, `${meta.id}/${profile}`).toBe(track.centerline.length);
        expect(Number.isFinite(quality.theoreticalLapSeconds), `${meta.id}/${profile}`).toBe(true);
        expect(quality.minimumEdgeMarginMeters, `${meta.id}/${profile}`).toBeGreaterThan(0.25);
        expect(quality.maximumCurvature, `${meta.id}/${profile}`).toBeLessThan(1);
        expect(quality.maximumRequiredDeceleration, `${meta.id}/${profile}`).toBeLessThanOrEqual(
          RACING_LINE_DECELERATION_LIMIT + 0.05
        );
        expect(quality.maximumRequiredAcceleration, `${meta.id}/${profile}`).toBeLessThanOrEqual(
          accelerationLimit + 0.05
        );
      }
      expect(proQuality.theoreticalLapSeconds, meta.id).toBeLessThan(
        defaultQuality.theoreticalLapSeconds
      );
      expect(aceQuality.theoreticalLapSeconds, meta.id).toBeLessThanOrEqual(
        proQuality.theoreticalLapSeconds
      );
      for (const [label, room] of [["pro", proRoom], ["ace", aceRoom]] as const) {
        for (let i = 0; i < room.plus.length; i++) {
          expect(Number.isFinite(room.plus[i]), `${meta.id}/${label} room+${i}`).toBe(true);
          expect(Number.isFinite(room.minus[i]), `${meta.id}/${label} room-${i}`).toBe(true);
          expect(room.plus[i], `${meta.id}/${label} room+${i}`).toBeGreaterThanOrEqual(0);
          expect(room.minus[i], `${meta.id}/${label} room-${i}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  for (const meta of TRACKS) {
    runDetailedBenchmark(
      `standing-start benchmark ${meta.name} (${meta.id})`,
      async () => {
        const track = getTrack(meta.id);
        const defaultRun = await runStandingStartLap(track, "default");
        const proRun = await runStandingStartLap(track, "pro");
        const aceRun = await runStandingStartLap(track, "ace");
        console.log(
          `[difficulty-benchmark] ${meta.id.padEnd(12)} ` +
            `default=${defaultRun.theoreticalLapSeconds.toFixed(2)}/${defaultRun.measuredLapSeconds?.toFixed(2) ?? "n/a"} ` +
            `pro=${proRun.theoreticalLapSeconds.toFixed(2)}/${proRun.measuredLapSeconds?.toFixed(2) ?? "n/a"} ` +
            `ace=${aceRun.theoreticalLapSeconds.toFixed(2)}/${aceRun.measuredLapSeconds?.toFixed(2) ?? "n/a"} ` +
            `off=${aceRun.maxOffTrackMeters.toFixed(2)} first=${aceRun.firstLapMaxOffTrackMeters.toFixed(2)} ` +
            `tilt=${aceRun.maxTiltRad.toFixed(3)} distance=${aceRun.distanceTraveledMeters.toFixed(0)}`
        );

        expect(defaultRun.measuredLapSeconds, `${meta.id} default lap`).not.toBeNull();
        expect(proRun.measuredLapSeconds, `${meta.id} Pro lap`).not.toBeNull();
        expect(aceRun.measuredLapSeconds, `${meta.id} Ace lap`).not.toBeNull();
        expect(defaultRun.distanceTraveledMeters, meta.id).toBeGreaterThan(track.lengthMeters);
        expect(proRun.distanceTraveledMeters, meta.id).toBeGreaterThan(track.lengthMeters);
        expect(aceRun.distanceTraveledMeters, meta.id).toBeGreaterThan(track.lengthMeters);
        for (const [label, run] of [["Pro", proRun], ["Ace", aceRun]] as const) {
          expect(run.maxTiltRad, `${meta.id} ${label}`).toBeLessThan(FLIP_THRESHOLD_RAD);
          expect(run.maxOffTrackMeters, `${meta.id} ${label}`).toBeLessThan(MAX_OFF_TRACK_METERS);
          expect(run.firstLapMaxOffTrackMeters, `${meta.id} ${label}`).toBeLessThan(MAX_OFF_TRACK_METERS);
        }
        expect(proRun.measuredLapSeconds!, meta.id).toBeLessThan(defaultRun.measuredLapSeconds!);
        expect(aceRun.measuredLapSeconds!, meta.id).toBeLessThan(proRun.measuredLapSeconds!);
        if (meta.id === "spielberg") {
          expect(proRun.measuredLapSeconds!, "Spielberg Pro standing-start").toBeLessThan(85);
        }
      },
      300000
    );
  }
});
