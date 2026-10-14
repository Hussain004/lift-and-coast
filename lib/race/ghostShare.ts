// The two ends of sharing a Time Trial ghost, built from the pieces that
// already exist: the codec (ghostCodec), the plausibility guard
// (ghostUploadGuard) and the table client (sharedGhosts). Upload encodes and
// validates before sending; download decodes and validates what came back,
// because a downloaded trace is exactly as untrusted as an uploaded one.

import type { TrackData } from "../tracks/types";
import { decodeGhost, encodeGhost, ghostDurationSeconds } from "./ghostCodec";
import { projectGhostToProgress } from "./ghostProgress";
import type { GhostSample } from "./ghostRecorder";
import { validateGhostUpload } from "./ghostUploadGuard";
import type { LeaderboardConfig, LeaderboardTransport } from "./leaderboardClient";
import {
  fetchGhostInfo,
  fetchGhostTrace,
  submitGhost,
  type SharedGhostInfo,
  type SharedGhostKind,
} from "./sharedGhosts";

/** Encodes and validates a lap's ghost; null (with a reason) when it should not be shared. */
export async function prepareGhostUpload(
  track: TrackData,
  samples: readonly GhostSample[],
  lapMs: number
): Promise<{ bytes: Uint8Array } | { error: string }> {
  const bytes = await encodeGhost(samples, track.centerline, lapMs);
  if (!(bytes instanceof Uint8Array)) return { error: bytes.reason };
  // Validate the DECODED trace: that is what every other player will replay.
  const decoded = await decodeGhost(bytes);
  if ("reason" in decoded) return { error: decoded.reason };
  const trace = projectGhostToProgress(track, decoded.samples, lapMs / 1000);
  if (trace === null) return { error: "ghost could not be projected onto the circuit" };
  const verdict = validateGhostUpload({
    lapSeconds: lapMs / 1000,
    sectorSeconds: [],
    sampleCount: decoded.samples.length,
    progressMeters: trace.progressMeters,
    trackLengthMeters: track.lengthMeters,
  });
  return verdict.ok ? { bytes } : { error: verdict.reason };
}

export interface ShareGhostOptions {
  config: LeaderboardConfig | null;
  track: TrackData;
  samples: readonly GhostSample[];
  lapMs: number;
  lapId: string;
  driverCode: string;
  /** Must match the lap row's client_id. */
  clientId: string;
  playerName?: string;
  accessToken?: string;
  /** Settles true once the lap row itself is stored: the ghost row needs it to exist. */
  lapPosted: Promise<boolean>;
  transport?: LeaderboardTransport;
}

/** Uploads a lap's ghost once its lap row is posted. Resolves false on any failure. */
export async function shareGhost(options: ShareGhostOptions): Promise<boolean> {
  try {
    const prepared = await prepareGhostUpload(options.track, options.samples, options.lapMs);
    if ("error" in prepared) return false;
    if (!(await options.lapPosted)) return false;
    return await submitGhost(
      options.config,
      {
        lapId: options.lapId,
        trackId: options.track.id,
        lapMs: options.lapMs,
        driverCode: options.driverCode,
        clientId: options.clientId,
        ...(options.playerName !== undefined ? { playerName: options.playerName } : {}),
        bytes: prepared.bytes,
      },
      options.accessToken,
      options.transport
    );
  } catch {
    return false;
  }
}

export interface LoadedSharedGhost {
  info: SharedGhostInfo;
  samples: GhostSample[];
  lapSeconds: number;
}

/**
 * Downloads and verifies a shared ghost. Null when there is none, the network
 * fails, or the trace does not stand up to the same checks an upload gets.
 */
export async function loadSharedGhost(
  config: LeaderboardConfig | null,
  track: TrackData,
  kind: SharedGhostKind,
  personalBestMs: number | null,
  transport: LeaderboardTransport = {}
): Promise<LoadedSharedGhost | null> {
  const info = await fetchGhostInfo(config, track.id, kind, personalBestMs, transport);
  if (info === null) return null;
  const bytes = await fetchGhostTrace(config, info.lapId, transport);
  if (bytes === null) return null;
  const decoded = await decodeGhost(bytes);
  if ("reason" in decoded) return null;
  const lapSeconds = info.lapMs / 1000;
  const trace = projectGhostToProgress(track, decoded.samples, lapSeconds);
  if (trace === null) return null;
  const verdict = validateGhostUpload({
    lapSeconds,
    sectorSeconds: [],
    sampleCount: decoded.samples.length,
    progressMeters: trace.progressMeters,
    trackLengthMeters: track.lengthMeters,
  });
  if (!verdict.ok || Math.abs(ghostDurationSeconds(decoded.samples.length) - lapSeconds) > 0.2) return null;
  return { info, samples: decoded.samples, lapSeconds };
}
