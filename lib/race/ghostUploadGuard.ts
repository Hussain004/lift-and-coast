// Upload guard for rival ghosts (roadmap 11.9, "Guard uploads - validate the
// lap time equals the ghost duration +/-0.1s, and sectors are monotonic").
//
// This is deliberately a PURE function over already-decoded data, and that is
// the whole design decision. The moment a ghost can be fetched from a shared
// table, its blob is attacker-controlled, and the checks that matter have to
// run somewhere the client cannot skip. Keeping the logic here rather than
// inlining it into the upload call means the server-side validator is this
// same code, already proven by these tests, rather than a second
// implementation written later and subtly different.
//
// WHAT THIS IS NOT: anti-cheat. The leaderboard's own migration records the
// same limitation for lap times - a client-submitted lap cannot be verified
// without replaying it server-side from an input trace, which is a different
// and much larger feature. These checks raise the cost of a careless or
// sloppy upload and make a malformed blob impossible to store. They do not
// make the board trustworthy against a determined cheater, and no comment
// here should be read as claiming otherwise.

import { GHOST_SAMPLE_HZ, ghostDurationSeconds } from "./ghostCodec";

/** The tolerance the plan specifies: claimed lap time vs. the trace's own span. */
export const GHOST_DURATION_TOLERANCE_SECONDS = 0.1;

/**
 * A track's plausible lap-time band, used only to catch absurd uploads. The
 * floor rejects a blob too short to be a real lap on any circuit; the ceiling
 * matches the leaderboard's own 30-minute bound so the two tables cannot
 * disagree about what a submittable lap is.
 */
const MIN_LAP_SECONDS = 30;
const MAX_LAP_SECONDS = 1800;

export interface GhostUploadCandidate {
  /** The lap time the client is claiming, in seconds. */
  lapSeconds: number;
  /** Sector split times in seconds, in order. May be empty. */
  sectorSeconds: number[];
  /** Sample count of the decoded trace. */
  sampleCount: number;
  /**
   * Metres travelled along the centerline, per sample. Used to tie the trace
   * to the circuit it claims: the first and last entries must be about one
   * lap apart.
   */
  progressMeters: number[];
  /**
   * The circuit's length. Required for the travel check, and deliberately so:
   * an earlier version of this guard guessed an average speed (20 m/s) and
   * rejected every genuine racing lap, because a real lap averages 50-90 m/s.
   * Comparing against the actual track length is both correct and stricter -
   * it is an exact expectation rather than a guess at a plausible band.
   */
  trackLengthMeters: number;
}

/**
 * How far the trace's travel may differ from one lap, as a fraction. 6% is
 * loose enough for a lap that started a little before the line or ran a few
 * metres wide at the flag, and tight enough that a trace covering half the
 * circuit, or two laps of it, is rejected.
 */
const TRAVEL_TOLERANCE = 0.06;

export type GhostUploadVerdict =
  | { ok: true; durationSeconds: number }
  | { ok: false; reason: string };

/**
 * Validates a decoded ghost against the lap it claims to be.
 *
 * Returns the trace's own duration on success so the caller stores THAT rather
 * than the client's number - the guard's practical effect is that the stored
 * time is derived from the bytes, not trusted from the request.
 */
export function validateGhostUpload(candidate: GhostUploadCandidate): GhostUploadVerdict {
  const { lapSeconds, sectorSeconds, sampleCount, progressMeters, trackLengthMeters } = candidate;

  if (!Number.isFinite(lapSeconds) || lapSeconds <= 0) {
    return { ok: false, reason: "lap time is not a positive number" };
  }
  if (!Number.isInteger(sampleCount) || sampleCount < 2) {
    return { ok: false, reason: "ghost needs at least two samples" };
  }
  if (!Number.isFinite(lapSeconds) || lapSeconds < MIN_LAP_SECONDS || lapSeconds > MAX_LAP_SECONDS) {
    return { ok: false, reason: `lap time ${lapSeconds.toFixed(2)}s is outside the plausible band` };
  }

  // The headline check. Because the format puts samples on an exact 10Hz grid
  // with the time implied by the index, a trace's real duration is knowable
  // without trusting anything in the blob - so a short trace attached to a
  // fast claimed time is detectable, which is the entire class of abuse this
  // catches.
  const duration = ghostDurationSeconds(sampleCount);
  if (Math.abs(duration - lapSeconds) > GHOST_DURATION_TOLERANCE_SECONDS) {
    return {
      ok: false,
      reason: `lap time ${lapSeconds.toFixed(3)}s does not match the ghost's ${duration.toFixed(
        3
      )}s duration (tolerance ${GHOST_DURATION_TOLERANCE_SECONDS}s)`,
    };
  }

  // Sectors must be monotonic and must add up to the lap. A non-monotonic
  // split is either a bug or an attempt to claim a sector advantage that the
  // lap time does not support.
  if (sectorSeconds.length > 0) {
    let previous = 0;
    for (const s of sectorSeconds) {
      if (!Number.isFinite(s) || s <= 0) {
        return { ok: false, reason: "sector times must be positive numbers" };
      }
      if (s <= previous) {
        return { ok: false, reason: "sector times are not strictly increasing" };
      }
      previous = s;
    }
    // Each sector is reported as a cumulative split, so the last one is the
    // lap. Anything else means the sectors and the lap time disagree.
    const last = sectorSeconds[sectorSeconds.length - 1];
    if (Math.abs(last - lapSeconds) > GHOST_DURATION_TOLERANCE_SECONDS * 5) {
      return {
        ok: false,
        reason: `final sector ${last.toFixed(3)}s disagrees with the lap time ${lapSeconds.toFixed(3)}s`,
      };
    }
  }

  // A trace that spans the right amount of TIME but covers no ground is the
  // other cheap forgery: park the car and claim a plausible lap. Comparing the
  // travel against the circuit's real length ties the blob to the track it
  // claims, so a trace lifted from a different circuit - or one that sits on
  // the line - cannot pass.
  if (progressMeters.length >= 2) {
    const first = progressMeters[0];
    const last = progressMeters[progressMeters.length - 1];
    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      return { ok: false, reason: "ghost progress contains non-finite values" };
    }
    if (!Number.isFinite(trackLengthMeters) || trackLengthMeters <= 0) {
      return { ok: false, reason: "track length must be a positive number" };
    }
    const travelled = Math.abs(last - first);
    const error = Math.abs(travelled - trackLengthMeters) / trackLengthMeters;
    if (error > TRAVEL_TOLERANCE) {
      return {
        ok: false,
        reason: `ghost covers ${Math.round(travelled)}m of a ${Math.round(
          trackLengthMeters
        )}m lap (${(error * 100).toFixed(1)}% out, tolerance ${(TRAVEL_TOLERANCE * 100).toFixed(0)}%)`,
      };
    }
  }

  return { ok: true, durationSeconds: duration };
}

/** Convenience: the sample count a legitimate ghost of this lap would carry. */
export function expectedGhostSampleCount(lapSeconds: number): number {
  return Math.round(lapSeconds * GHOST_SAMPLE_HZ) + 1;
}
