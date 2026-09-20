// Driver personalities and difficulty tiers for the AI field.
//
// The roster stays identity-only (see lib/race/rosterData.ts): traits live
// here, derived deterministically from the driver's FIA code, so the same
// code always drives the same way on every visit and both sides of a net
// room agree without a round-trip. Deterministic does not mean uniform:
// the field spreads ~3.5% on raw pace, overtakes, makes mistakes, and runs
// different tire curves - a train that holds formation all race is gone.
//
// Stability discipline (non-negotiable, see lib/ai/pathFollower.ts): every
// trait acts through PACE levers only - target-speed scaling, throttle
// lifts, a bounded lateral offset on straights. The steering/lookahead
// control law itself is never retuned per driver.
export type AIDifficulty = "rookie" | "club" | "pro" | "ace";

export const DIFFICULTY_OPTIONS: { id: AIDifficulty; label: string; blurb: string }[] = [
  { id: "rookie", label: "Rookie", blurb: "Gentle field, generous mistakes" },
  { id: "club", label: "Club", blurb: "Lively midfield, occasional errors" },
  { id: "pro", label: "Pro", blurb: "The reference pace" },
  { id: "ace", label: "Ace", blurb: "Faster, braver, rarer mistakes" },
];

export const DEFAULT_DIFFICULTY: AIDifficulty = "pro";

export function parseDifficulty(raw: string | null): AIDifficulty {
  return raw === "rookie" || raw === "club" || raw === "ace" ? raw : DEFAULT_DIFFICULTY;
}

/** Global pace multiplier applied to every AI target speed. */
export function difficultyPaceScale(difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "rookie":
      return 0.972;
    case "club":
      return 0.988;
    case "pro":
      return 1.0;
    case "ace":
      return 1.014;
  }
}

/** Global aggression shift applied to every AI driver. */
export function difficultyAggressionShift(difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "rookie":
      return -0.25;
    case "club":
      return -0.08;
    case "pro":
      return 0;
    case "ace":
      return 0.18;
  }
}

export interface DriverTraits {
  /** Target-speed multiplier, roughly 0.985..1.02 across the field. */
  pace: number;
  /** 0 (cautious) .. 1 (dive-bomber): overtake willingness, follow gap. */
  aggression: number;
  /** 0 (metronome) .. 1 (error-prone): mistake probability and severity. */
  risk: number;
  /** -1 (fast early, fades) .. +1 (comes alive late): tire-curve direction. */
  latePace: number;
  /** Preferred passing side: 1 = left, -1 = right. */
  overtakeSide: 1 | -1;
}

/** FNV-1a over the code string: stable across visits, platforms, sessions. */
export function hashDriverCode(code: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i++) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic traits for one driver code (see the module comment). */
export function traitsForDriver(code: string): DriverTraits {
  const h = hashDriverCode(code);
  const unit = (shift: number): number => ((h >>> shift) % 1000) / 1000;
  return {
    // 3.5% across the field: adjacent cars differ ~0.2%/lap (tenths, not
    // seconds), but the fastest visibly marches and backmarkers become
    // traffic - a 2% spread proved too fine to produce a pass inside a
    // 3-lap sprint (see the live tower logs that sized this).
    pace: 0.985 + unit(0) * 0.035,
    aggression: 0.15 + unit(10) * 0.7,
    risk: unit(20) * unit(5),
    latePace: unit(15) * 2 - 1,
    overtakeSide: ((h >>> 28) & 1) === 0 ? 1 : -1,
  };
}

/**
 * Tire-curve multiplier over a race distance: latePace > 0 means the driver
 * gets relatively faster as the race goes on (and vice versa). Sized to
 * move races, not just color them: opposite tire types swing ~2% across
 * the distance, so early flyers get caught and passed late - without a
 * delta this big the field self-sorts by raw pace on lap one and stays
 * there, which is exactly the formation train this system exists to break.
 */
export function tireCurveMultiplier(latePace: number, raceProgress01: number): number {
  const progress = Math.min(1, Math.max(0, raceProgress01));
  return 1 + latePace * (progress - 0.35) * 0.02;
}

/** Mulberry32: tiny seeded RNG for per-race mistake scheduling. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
