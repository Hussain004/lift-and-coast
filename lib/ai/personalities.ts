// Driver personalities and difficulty tiers for the AI field.
//
// The roster stays identity-only (see lib/race/rosterData.ts): traits live
// here, derived deterministically from the driver's FIA code, so the same
// code always drives the same way on every visit and both sides of a net
// room agree without a round-trip. Deterministic does not mean uniform:
// the field spreads ~6% on raw pace (tiers plus per-driver jitter),
// overtakes, makes mistakes, and runs different tire curves - a train that
// holds formation all race is gone.
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
  { id: "ace", label: "Ace", blurb: "Fastest launches, strongest pace, rare mistakes" },
];

export const DEFAULT_DIFFICULTY: AIDifficulty = "pro";

export function parseDifficulty(raw: string | null): AIDifficulty {
  return raw === "rookie" || raw === "club" || raw === "ace" ? raw : DEFAULT_DIFFICULTY;
}

/** Global pace multiplier applied to every AI target speed. Ace is now a
 * genuine benchmark tier rather than a cosmetic 8% label: its target envelope
 * sits above the normal drag-limited cruise, while the path follower's pace
 * clamp still bounds cornering overspeed. Pro remains the reference pace. */
export function difficultyPaceScale(difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "rookie":
      return 0.95;
    case "club":
      return 0.985;
    case "pro":
      return 1.0;
    case "ace":
      return 1.18;
  }
}

/**
 * Engine-force multiplier for the AI field. Pace scale changes the target
 * speed envelope; this changes how quickly the car can actually get there.
 * Most Ace circuits use 1.12. Spa keeps its separately validated 1.5 package;
 * Suzuka and Madrid retain the reference force because their bridge/banked
 * geometry is sensitive to longitudinal load, even though their Ace lines
 * are substantially faster. The boost cap in vehicle.ts still applies
 * afterward.
 */
const ACE_ENGINE_FORCE_SCALE_BY_TRACK: Record<string, number> = {
  spa: 1.5,
  suzuka: 1.0,
  madrid: 1.0,
};

export function difficultyEngineForceScale(
  difficulty: AIDifficulty,
  trackId?: string
): number {
  switch (difficulty) {
    case "rookie":
      return 0.94;
    case "club":
      return 0.98;
    case "pro":
      return 1.0;
    case "ace":
      return (trackId === undefined ? undefined : ACE_ENGINE_FORCE_SCALE_BY_TRACK[trackId]) ?? 1.12;
  }
}

/** Global aggression shift applied to every AI driver. Ace shifts the whole
 * field into lunge range earlier, sits closer in the tow, and deploys
 * Push-to-Pass more freely (aggression feeds shouldDeployBoost). */
export function difficultyAggressionShift(difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "rookie":
      return -0.25;
    case "club":
      return -0.08;
    case "pro":
      return 0;
    case "ace":
      return 0.35;
  }
}

/** Mistake-rate multiplier: rookies bin it, aces almost never do. */
export function difficultyMistakeScale(difficulty: AIDifficulty): number {
  switch (difficulty) {
    case "rookie":
      return 1.6;
    case "club":
      return 1.2;
    case "pro":
      return 1.0;
    case "ace":
      return 0.35;
  }
}

export interface DriverTraits {
  /** Target-speed multiplier: tier base plus individual jitter. */
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

/**
 * Performance tiers (1 = elite). The top five are the proven race
 * winners; the rest sort by recent form into works/points/backmarker
 * bands. Tiers set the base pace and aggression - the hash jitter below
 * keeps teammates and rivals distinguishable inside a band, so no two
 * drivers are identical.
 */
export const DRIVER_TIERS: Record<string, 1 | 2 | 3 | 4> = {
  VER: 1,
  LEC: 1,
  HAM: 1,
  ANT: 1,
  NOR: 1,
  PIA: 2,
  RUS: 2,
  ALO: 2,
  SAI: 2,
  GAS: 2,
  OCO: 2,
  HUL: 3,
  ALB: 3,
  LAW: 3,
  BOT: 3,
  PER: 3,
  HAD: 3,
  STR: 4,
  COL: 4,
  BOR: 4,
  BEA: 4,
  LIN: 4,
};

const TIER_PACE: Record<1 | 2 | 3 | 4, number> = {
  1: 0.025,
  2: 0.008,
  3: -0.008,
  4: -0.025,
};

const TIER_AGGRESSION: Record<1 | 2 | 3 | 4, [number, number]> = {
  1: [0.75, 1.0],
  2: [0.55, 0.8],
  3: [0.35, 0.6],
  4: [0.18, 0.42],
};

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
  const tier = DRIVER_TIERS[code] ?? 3;
  const [aggrLo, aggrHi] = TIER_AGGRESSION[tier];
  return {
    pace: 1 + TIER_PACE[tier] + (unit(0) - 0.5) * 0.01,
    aggression: aggrLo + unit(10) * (aggrHi - aggrLo),
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
