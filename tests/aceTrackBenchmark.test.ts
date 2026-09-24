// The inexpensive geometry gate runs with the normal suite. The full
// standing-start sweep is opt-in because it drives every real trimesh twice:
// `npm run diagnose:ace`.
import { describe, expect, it } from "vitest";
import { getLineRoom, getRacingLine } from "../lib/tracks/racingLineCache";
import { computeRacingLine } from "../lib/tracks/racingLine";
import { analyzeRacingLine, RACING_LINE_ACCELERATION_LIMIT, RACING_LINE_DECELERATION_LIMIT } from "../lib/tracks/racingLineQuality";
import { TRACKS } from "../lib/tracks/registry";
import { getTrack } from "../lib/tracks/trackData";
import { runStandingStartLap } from "./helpers/aceBenchmark";

const MAX_OFF_TRACK_METERS = 6;
const FLIP_THRESHOLD_RAD = 0.6;
const runDetailedBenchmark = process.env.ACE_BENCHMARK === "1" ? it : it.skip;

describe("all-track Ace racing-line profiles", () => {
  it("keeps synthetic/unregistered tracks on the conservative Ace fallback", () => {
    const synthetic = { ...getTrack("spa"), id: "synthetic-ace-track" };
    const line = computeRacingLine(synthetic, "ace");
    expect(line[0].steeringMode).toBe("pure-pursuit");
    expect(line[0].steeringMaxPace).toBe(1.08);
  });

  it("keeps every registered default and Ace line finite, feasible, and faster on paper", () => {
    for (const meta of TRACKS) {
      const track = getTrack(meta.id);
      const defaultLine = getRacingLine(track, "default");
      const aceLine = getRacingLine(track, "ace");
      const defaultQuality = analyzeRacingLine(track, defaultLine);
      const aceQuality = analyzeRacingLine(track, aceLine);
      const room = getLineRoom(track, "ace");

      expect(aceLine.length, meta.id).toBe(track.centerline.length);
      expect(Number.isFinite(aceQuality.theoreticalLapSeconds), meta.id).toBe(true);
      expect(aceQuality.minimumEdgeMarginMeters, meta.id).toBeGreaterThan(0.25);
      expect(aceQuality.maximumCurvature, meta.id).toBeLessThan(1);
      expect(aceQuality.maximumRequiredDeceleration, meta.id).toBeLessThanOrEqual(
        RACING_LINE_DECELERATION_LIMIT + 0.05
      );
      expect(aceQuality.maximumRequiredAcceleration, meta.id).toBeLessThanOrEqual(
        RACING_LINE_ACCELERATION_LIMIT + 0.05
      );
      expect(aceQuality.theoreticalLapSeconds, meta.id).toBeLessThan(
        defaultQuality.theoreticalLapSeconds
      );
      for (let i = 0; i < room.plus.length; i++) {
        expect(Number.isFinite(room.plus[i]), `${meta.id} room+${i}`).toBe(true);
        expect(Number.isFinite(room.minus[i]), `${meta.id} room-${i}`).toBe(true);
        expect(room.plus[i], `${meta.id} room+${i}`).toBeGreaterThanOrEqual(0);
        expect(room.minus[i], `${meta.id} room-${i}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  for (const meta of TRACKS) {
    runDetailedBenchmark(
      `standing-start benchmark ${meta.name} (${meta.id})`,
      async () => {
        const track = getTrack(meta.id);
        const defaultRun = await runStandingStartLap(track, "default");
        const aceRun = await runStandingStartLap(track, "ace");
        console.log(
          `[ace-benchmark] ${meta.id.padEnd(12)} ` +
            `default=${defaultRun.theoreticalLapSeconds.toFixed(2)}/${defaultRun.measuredLapSeconds?.toFixed(2) ?? "n/a"} ` +
            `ace=${aceRun.theoreticalLapSeconds.toFixed(2)}/${aceRun.measuredLapSeconds?.toFixed(2) ?? "n/a"} ` +
            `off=${aceRun.maxOffTrackMeters.toFixed(2)} first=${aceRun.firstLapMaxOffTrackMeters.toFixed(2)} ` +
            `tilt=${aceRun.maxTiltRad.toFixed(3)} distance=${aceRun.distanceTraveledMeters.toFixed(0)}`
        );

        expect(defaultRun.measuredLapSeconds, `${meta.id} default lap`).not.toBeNull();
        expect(aceRun.measuredLapSeconds, `${meta.id} Ace lap`).not.toBeNull();
        expect(defaultRun.distanceTraveledMeters, meta.id).toBeGreaterThan(track.lengthMeters);
        expect(aceRun.distanceTraveledMeters, meta.id).toBeGreaterThan(track.lengthMeters);
        expect(aceRun.maxTiltRad, meta.id).toBeLessThan(FLIP_THRESHOLD_RAD);
        expect(aceRun.maxOffTrackMeters, meta.id).toBeLessThan(MAX_OFF_TRACK_METERS);
        expect(aceRun.firstLapMaxOffTrackMeters, meta.id).toBeLessThan(MAX_OFF_TRACK_METERS);
        expect(aceRun.measuredLapSeconds!, meta.id).toBeLessThan(defaultRun.measuredLapSeconds!);
      },
      300000
    );
  }
});
