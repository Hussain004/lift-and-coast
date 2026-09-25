export type SectorColor = "purple" | "green" | "yellow";

export interface SectorCrossing {
  sectorIndex: number;
  sectorSeconds: number;
  color: SectorColor;
}

interface Gate {
  x: number;
  z: number;
  forward: { x: number; z: number };
}

const GATE_CAPTURE_RADIUS_METERS = 30;

function toGate(g: { x: number; z: number; headingRad: number }): Gate {
  return {
    x: g.x,
    z: g.z,
    forward: { x: -Math.sin(g.headingRad), z: -Math.cos(g.headingRad) },
  };
}

/**
 * Splits a lap into `gateConfigs.length + 1` sectors using boundary gates
 * (see computeSectorGates in lib/tracks/sectors.ts), timing each one and
 * classifying it purple/green/yellow (plan section 13) against two
 * session-local reference sets: the fastest this sector has ever been run
 * (purple - only set by an eligible lap), and this sector's time from the
 * current best LAP specifically (green - beating that, without being the
 * outright fastest). Neither is persisted (unlike the best lap/ghost -
 * see lib/persistence/personalBests.ts) - deliberately, to avoid a second,
 * redundant IndexedDB shape for the same underlying lap data.
 *
 * Gates are detected in strict order via forward-projection crossings, the
 * same technique lapTimer.ts uses for the finish line - a gate is only
 * checked once every earlier gate has already been crossed this lap, so a
 * spin or reverse near a boundary can't register a bogus split out of
 * order. The final sector (crossing the finish line itself) is completed
 * by calling onLapEnd, driven by the lap timer's own crossedFinishLine -
 * not by a third progress-based gate, since that's already exactly what
 * lapTimer.ts detects robustly.
 */
export function createSectorTimer(gateConfigs: { x: number; z: number; headingRad: number }[]) {
  const gates = gateConfigs.map(toGate);
  const sectorCount = gates.length + 1;
  let nextGateIndex = 0;
  let prevSignedForward: number | null = null;
  let sectorStartSeconds = 0;
  let currentLapSectors: number[] = [];
  const sessionBestSectors: (number | null)[] = new Array(sectorCount).fill(null);
  let bestLapSectors: (number | null)[] = new Array(sectorCount).fill(null);

  function classify(sectorIndex: number, seconds: number, eligible: boolean): SectorColor {
    const sessionBest = sessionBestSectors[sectorIndex];
    if (eligible && (sessionBest === null || seconds < sessionBest)) {
      sessionBestSectors[sectorIndex] = seconds;
      return "purple";
    }
    const lapBest = bestLapSectors[sectorIndex];
    if (lapBest !== null && seconds < lapBest) return "green";
    return "yellow";
  }

  /**
   * Call every frame with the car's (x, z) position, the current lap's
   * elapsed time, and this lap's eligibility (see lapHadDiscontinuityRef /
   * lapInvalidRef in Car.tsx) - only an eligible lap's sector time can set
   * a new purple. Returns a completed split when a gate is crossed.
   */
  function update(x: number, z: number, currentLapSeconds: number, eligible: boolean): SectorCrossing | null {
    if (nextGateIndex >= gates.length) return null;
    const gate = gates[nextGateIndex];
    const signedForward = (x - gate.x) * gate.forward.x + (z - gate.z) * gate.forward.z;

    if (
      prevSignedForward !== null &&
      prevSignedForward < 0 &&
      signedForward >= 0 &&
      Math.hypot(x - gate.x, z - gate.z) <= GATE_CAPTURE_RADIUS_METERS
    ) {
      // A closed circuit can pass the same infinite gate line elsewhere
      // (Spielberg's sector-2 line is a good example). Require the crossing
      // sample to be physically near the authored gate, not merely on its
      // projected line.
      // Clamped at 0 - a rewind mid-sector can roll currentLapSeconds back
      // past sectorStartSeconds (see lapTimer.ts's own rewindBy), which
      // would otherwise show a negative split. A qualifying rewind can still
      // be accepted after the underlying excursion is corrected, so the
      // clamp is a cosmetic safety net for that corrected lap.
      const sectorSeconds = Math.max(0, currentLapSeconds - sectorStartSeconds);
      currentLapSectors.push(sectorSeconds);
      const color = classify(nextGateIndex, sectorSeconds, eligible);
      const result: SectorCrossing = { sectorIndex: nextGateIndex, sectorSeconds, color };
      sectorStartSeconds = currentLapSeconds;
      nextGateIndex += 1;
      prevSignedForward = null;
      return result;
    }

    prevSignedForward = signedForward;
    return null;
  }

  /**
   * Call once when the lap timer reports crossedFinishLine, with that
   * lap's final time and whether it was accepted as a new best (see
   * Car.tsx's `eligible`/`wasNewBest`) - completes the final sector and
   * resets for the next lap.
   */
  function onLapEnd(lastLapSeconds: number, eligible: boolean, wasNewBest: boolean): SectorCrossing {
    const finalSectorIndex = sectorCount - 1;
    const sectorSeconds = Math.max(0, lastLapSeconds - sectorStartSeconds);
    currentLapSectors.push(sectorSeconds);
    const color = classify(finalSectorIndex, sectorSeconds, eligible);

    // Only a fully-formed set of splits (every gate actually crossed in
    // order) replaces the reference - a lap that cut across a boundary
    // (skipping a gate) has too few entries to trust index-for-index.
    if (wasNewBest && currentLapSectors.length === sectorCount) {
      bestLapSectors = currentLapSectors;
    }
    reset();

    return { sectorIndex: finalSectorIndex, sectorSeconds, color };
  }

  /**
   * Clears in-progress sector state without classifying or recording
   * anything - call both internally between laps and externally when the
   * car is teleported outside the normal lap flow (the off-track reset in
   * Car.tsx). Without the external call, nextGateIndex would still point
   * at whatever gate was being approached before the teleport, so the car
   * driving from the start line would silently miss gate 0 (its crossing
   * check is skipped since a later gate is expected) and later register a
   * garbage split spanning the teleport itself. Doesn't try to salvage or
   * classify whatever partial sector was in progress - that lap is
   * already tainted (the teleport also sets lapHadDiscontinuityRef in
   * Car.tsx), so its splits were never going to count anyway.
   */
  function reset() {
    currentLapSectors = [];
    sectorStartSeconds = 0;
    nextGateIndex = 0;
    prevSignedForward = null;
  }

  /**
   * Rewinds the in-progress sector baseline after the lap clock is rolled
   * back. Gate crossings already recorded from the discarded future cannot be
   * trusted, so start a fresh split sequence at the restored lap time. The
   * final sector still completes at the next finish-line crossing; this keeps
   * a corrected qualifying rewind from displaying stale or negative splits.
   */
  function rewindTo(currentLapSeconds: number) {
    currentLapSectors = [];
    sectorStartSeconds = Math.max(0, currentLapSeconds);
    nextGateIndex = 0;
    prevSignedForward = null;
  }

  return { update, onLapEnd, reset, rewindTo };
}
