/**
 * Small, data-only circuit environment table shared by the terrain mesh,
 * surface classifier, flora placement, and barrier generator.
 *
 * Track geometry tells us where the ribbon is, but not what the runoff
 * around it is made from. Keeping that choice here prevents the visual
 * ground from saying "grass" while the physics classifier calls the same
 * corner a gravel trap, and gives newly added circuits a sensible default.
 *
 * `setbackMeters` is the load-bearing field of the barrier profile: it is the
 * distance from the painted edge to the inside face of the barrier, and it is
 * simultaneously the run-off width, the physics wall's position, and the
 * reason the wall can be solid without the AI ever reaching it. Real F1
 * circuits have very different amounts of room - Monza's run-off after T1 is
 * metres deep, a Monaco hotel wall is not - so this is per-track rather than
 * a single number.
 */

export type RunoffKind = "grass" | "paved" | "gravel" | "concrete";

/**
 * What stops a car that runs off the road. This is both the visual and the
 * physical barrier, and it is deliberately not the same thing as
 * RunoffKind: Monaco's run-off is concrete and its wall is a concrete
 * barrier, while Las Vegas uses TecPro blocks behind a chain-link fence
 * because the whole venue sits inside the fencing.
 */
export type BarrierStyle =
  /** Steel guardrail on posts, with a top rail - the modern default. */
  | "armco"
  /** Concrete wall, taller and heavier than armco; street circuits. */
  | "concrete"
  /** Impact-absorbing foam blocks stacked behind the armco. */
  | "tecpro"
  /**
   * A tall open catch fence standing behind the barrier line. The fence
   * itself is not a collider - the barrier in front of it is - it exists so
   * street venues read as fenced-in, which is the defining visual of Las
   * Vegas and Singapore.
   */
  | "fence";

export interface RunoffProfile {
  kind: RunoffKind;
  /**
   * Whether gravel traps are cut into the run-off at the circuit's tight
   * corners. False for street circuits, which have none by design - a car
   * that slides at Monaco hits a wall, it does not bury itself in sand.
   */
  gravelTraps: boolean;
}

export interface BarrierProfile {
  style: BarrierStyle;
  /** Painted edge to the inside face of the barrier, metres. */
  setbackMeters: number;
  /** Visual height of the barrier above the local ground, metres. */
  heightMeters: number;
  /**
   * Physical half-thickness of the wall collider, metres.
   *
   * The visual barrier is a thin steel section; this is the collision slab,
   * and it is deliberately much deeper. Rapier's discrete (non-CCD) narrow
   * phase resolves a 1/60s step against it, and the car covers ~1.4m per
   * step at its measured 80 m/s top speed (~1.7m in low-drag), so a
   * realistic-looking 0.5m wall would simply be driven through at racing
   * speed - the exact failure this collider exists to prevent. 2.0m half
   * thickness gives 4m of slab, which no car in this game can cross in one
   * step. The extra depth is added OUTWARD so the near face still sits
   * exactly at setbackMeters and the player never loses run-off to it.
   */
  halfThicknessMeters: number;
  /** Catch fence behind the barrier. */
  catchFence: boolean;
}

const DEFAULT_RUNOFF: RunoffProfile = { kind: "grass", gravelTraps: true };

const RUNOFF_BY_TRACK: Record<string, RunoffProfile> = {
  // Street circuits: no gravel anywhere, and the run-off is a designed
  // surface rather than a verge. Monaco and Baku are concrete/asphalt; Las
  // Vegas is deliberately paved all the way out to the barriers because its
  // off-track area is part of the Strip race surface, not a field.
  monaco: { kind: "concrete", gravelTraps: false },
  singapore: { kind: "paved", gravelTraps: false },
  baku: { kind: "concrete", gravelTraps: false },
  lasvegas: { kind: "paved", gravelTraps: false },

  // Desert circuits use broad sand runoffs. Keeping this as a distinct kind
  // (rather than painting everything green) also gives the surface model a
  // believable low-grip, high-drag punishment for a slide.
  bahrain: { kind: "gravel", gravelTraps: true },
  lusail: { kind: "gravel", gravelTraps: true },
};

// Permanent circuits. A "generic" circuit still gets 14m of run-off, which
// is roughly the shallow end of what real venues have; the entries below are
// the ones whose character is defined by how much room they leave.
const DEFAULT_BARRIER: BarrierProfile = {
  style: "armco",
  setbackMeters: 14,
  heightMeters: 1.1,
  halfThicknessMeters: 2,
  catchFence: false,
};

const BARRIER_BY_TRACK: Record<string, Partial<BarrierProfile>> = {
  // The famous one: the run-off after T1 is a huge gravel/asphalt expanse
  // with almost nothing to hit. Generous by design.
  monza: { setbackMeters: 26 },
  silverstone: { setbackMeters: 20, style: "tecpro" },
  spa: { setbackMeters: 20 },
  suzuka: { setbackMeters: 18 },
  interlagos: { setbackMeters: 17 },
  barcelona: { setbackMeters: 17, style: "tecpro" },
  zandvoort: { setbackMeters: 15 },
  budapest: { setbackMeters: 16 },
  melbourne: { setbackMeters: 15 },
  montreal: { setbackMeters: 16 },
  mexico: { setbackMeters: 16 },
  shanghai: { setbackMeters: 15, style: "tecpro" },
  yasmarina: { setbackMeters: 15 },
  hockenheim: { setbackMeters: 15 },
  sepang: { setbackMeters: 16 },
  sochi: { setbackMeters: 17 },
  nurburgring: { setbackMeters: 17 },
  miami: { setbackMeters: 15 },
  madrid: { setbackMeters: 16, style: "tecpro" },
  spielberg: { setbackMeters: 20 },
  cota: { setbackMeters: 18 },

  // Street venues are fenced in, and the run-off is a narrow apron between
  // the road and the wall - which is what makes them frightening.
  monaco: { style: "concrete", setbackMeters: 5.5, heightMeters: 1.3, catchFence: false },
  singapore: { style: "concrete", setbackMeters: 7, heightMeters: 1.3, catchFence: true },
  baku: { style: "concrete", setbackMeters: 9, heightMeters: 1.3, catchFence: true },
  // Las Vegas is the poster child for this: a continuous catch fence down
  // both sides of the Strip, with the barrier tucked right against it.
  lasvegas: { style: "tecpro", setbackMeters: 6.5, heightMeters: 1.2, catchFence: true },
};

export function runoffProfileForTrack(trackId: string): RunoffProfile {
  return RUNOFF_BY_TRACK[trackId] ?? DEFAULT_RUNOFF;
}

export function runoffKindForTrack(trackId: string): RunoffKind {
  return runoffProfileForTrack(trackId).kind;
}

const RUNOFF_COLORS: Record<RunoffKind, string> = {
  grass: "#2E4A24",
  paved: "#3B3D42",
  gravel: "#8A7958",
  concrete: "#4A4A46",
};

export function runoffColorForTrack(trackId: string): string {
  return RUNOFF_COLORS[runoffKindForTrack(trackId)];
}

/** True when the runoff should use an asphalt/concrete texture. */
export function isPavedRunoff(trackId: string): boolean {
  const kind = runoffKindForTrack(trackId);
  return kind === "paved" || kind === "concrete";
}

export function barrierProfileForTrack(trackId: string): BarrierProfile {
  return { ...DEFAULT_BARRIER, ...BARRIER_BY_TRACK[trackId] };
}

/** True when this circuit cuts gravel traps at its tightest corners. */
export function hasGravelTraps(trackId: string): boolean {
  return runoffProfileForTrack(trackId).gravelTraps;
}
