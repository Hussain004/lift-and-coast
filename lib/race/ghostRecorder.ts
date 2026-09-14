export interface GhostPose {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number; w: number };
}

export interface GhostSample extends GhostPose {
  elapsedSeconds: number;
}

/**
 * Records a "ghost" of the fastest lap - position/rotation samples over
 * time - for a translucent playback car other laps can race against (plan
 * section 7: "Time Trial - ghost replays"). Time-indexed rather than
 * progress-indexed like the delta timer (see deltaTimer.ts): the ghost
 * should show where the reference lap's car physically was at the same
 * elapsed time into the lap, not at the same track distance - the standard
 * "race your ghost" presentation.
 *
 * `endLap`'s `eligible` flag should come from the same gate the delta timer
 * uses (see its own endLap comment) - a rewound or invalidated lap must
 * never become the ghost either, for the same reason: recordSample calls
 * simply pause during a rewind (see isRewindingRef in Car.tsx), so a lap
 * that included one has a real position discontinuity at a point in time
 * that doesn't match its own recorded timeline.
 */
// See the identical constant/reasoning in deltaTimer.ts - a lap this long
// will never be a real best lap, so recording stops rather than growing
// unbounded across a session where the player never crosses the line.
export const MAX_RECORDING_SAMPLES = 20000;

export function createGhostRecorder() {
  let recording: GhostSample[] = [];
  let reference: GhostSample[] | null = null;
  let wasOverlong = false;

  function recordSample(elapsedSeconds: number, pose: GhostPose) {
    if (recording.length < MAX_RECORDING_SAMPLES) {
      recording.push({ elapsedSeconds, position: pose.position, rotation: pose.rotation });
    } else {
      wasOverlong = true;
    }
  }

  function endLap(eligible: boolean) {
    if (eligible && !wasOverlong) reference = recording;
    recording = [];
    wasOverlong = false;
  }

  /** The current reference lap's samples, for persisting alongside its lap time. */
  function getReference(): GhostSample[] | null {
    return reference;
  }

  /**
   * Replaces the reference outright - for loading a previously-persisted
   * best lap after construction (the async IndexedDB read in Car.tsx can't
   * finish before useRef's initial createGhostRecorder() call, unlike
   * initialReference above which only covers a reference known up front).
   */
  function setReference(samples: GhostSample[] | null) {
    reference = samples;
  }

  function poseAt(elapsedSeconds: number): GhostPose | null {
    if (!reference || reference.length === 0) return null;
    const first = reference[0];
    if (elapsedSeconds <= first.elapsedSeconds) {
      return { position: first.position, rotation: first.rotation };
    }
    const last = reference[reference.length - 1];
    if (elapsedSeconds >= last.elapsedSeconds) {
      return { position: last.position, rotation: last.rotation };
    }

    for (let i = 1; i < reference.length; i++) {
      const a = reference[i - 1];
      const b = reference[i];
      if (elapsedSeconds <= b.elapsedSeconds) {
        const span = b.elapsedSeconds - a.elapsedSeconds;
        const t = span <= 0 ? 0 : (elapsedSeconds - a.elapsedSeconds) / span;
        return {
          position: lerpVec3(a.position, b.position, t),
          rotation: nlerpQuat(a.rotation, b.rotation, t),
        };
      }
    }
    return { position: last.position, rotation: last.rotation };
  }

  return { recordSample, endLap, poseAt, getReference, setReference };
}

function lerpVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  t: number
) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

/**
 * Normalized-lerp rather than a true slerp - a standard, cheap
 * approximation for real-time playback smoothing (not scientifically
 * precise rotation blending), avoiding a trig-heavy implementation for a
 * ghost car nobody examines frame-by-frame.
 */
function nlerpQuat(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
  t: number
) {
  // Quaternions q and -q represent the same rotation (double cover) - if
  // the two samples ended up on opposite hemispheres, negating one before
  // blending takes the short way around instead of spinning the long way.
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1;
  const x = a.x + (sign * b.x - a.x) * t;
  const y = a.y + (sign * b.y - a.y) * t;
  const z = a.z + (sign * b.z - a.z) * t;
  const w = a.w + (sign * b.w - a.w) * t;
  const len = Math.hypot(x, y, z, w) || 1;
  return { x: x / len, y: y / len, z: z / len, w: w / len };
}
