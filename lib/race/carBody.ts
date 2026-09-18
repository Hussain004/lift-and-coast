// Plan section 11 (retro-modern) + the garage livery (lib/race/roster.ts):
// the F1 car body as data, not JSX. Real panels are stepped boxes in the
// PS1 spirit - no sculpted meshes, no assets - plus a sphere helmet, a
// torus halo ring, and dressed wheels (see app/race/F1CarBody.tsx, the only
// consumer). Dimensions key off the physics chassis half-extents and wheel
// stations passed in, so the visuals can never silently outgrow the
// colliders they dress; origin, axes and units match the RigidBody frame
// (+x right, +y up, -z forward, meters).
//
// Nothing here touches physics: every panel is scenery inside the visual
// group, while the solid colliders stay exactly the chassis cuboid plus
// the (mesh-less) raycast wheels.
//
// Joinery rule: abutting boxes always interpenetrate by a centimeter or
// two, never merely touch - touching faces are coplanar quads that
// z-fight, while an overlap reads as one merged solid.

export type BodyPanelColor =
  | "livery"
  | "carbon"
  | "helmet"
  | "visor"
  | "tire"
  | "rim"
  | "light";

export interface BodyPanel {
  size: [number, number, number];
  position: [number, number, number];
  color: BodyPanelColor;
  /** The one moving part: the rear-wing top flap, rendered by the
   * component inside a pivot group at its leading edge and rotated open
   * in low-drag mode (see app/race/F1CarBody.tsx). */
  flap?: boolean;
}

export interface F1BodyGeometry {
  panels: BodyPanel[];
  /** Helmet sphere: radius + center. */
  helmet: { radius: number; position: [number, number, number] };
  /** Halo torus: ring radius, tube, center (flat, full ring - the rear gap
   * is sub-pixel at game distance, and a closed ring has no orientation to
   * get backwards). */
  halo: { radius: number; tube: number; position: [number, number, number] };
}

export function computeF1BodyPanels(
  halfExtents: [number, number, number],
  wheelStations: { x: number; z: number }[]
): F1BodyGeometry {
  const hz = halfExtents[2];
  const panels: BodyPanel[] = [];
  const box = (
    size: [number, number, number],
    position: [number, number, number],
    color: BodyPanelColor,
    flap = false
  ) => {
    panels.push({ size, position, color, flap });
  };

  // Nose: two shrinking steps from the tip into the monocoque.
  box([0.46, 0.26, 0.8], [0, -0.08, -hz + 0.4], "livery");
  box([0.66, 0.4, 0.8], [0, -0.02, -hz + 1.17], "livery");
  // Monocoque tub.
  box([1.0, 0.62, 1.5], [0, 0.02, 0.3], "livery");
  // Cockpit opening the helmet sits in.
  box([0.56, 0.12, 0.9], [0, 0.36, 0.35], "carbon");
  // Sidepods, mirrored.
  for (const side of [-1, 1] as const) {
    box([0.42, 0.42, 1.3], [side * 0.62, -0.06, 0.35], "livery");
  }
  // Airbox over the driver's head, engine cover tapering back, shark fin.
  box([0.44, 0.5, 0.6], [0, 0.5, 0.85], "livery");
  box([0.3, 0.36, 1.0], [0, 0.4, 1.47], "livery");
  box([0.07, 0.55, 1.1], [0, 0.55, 1.45], "livery");
  // Gearbox block the rear suspension mounts to.
  box([0.4, 0.35, 0.7], [0, 0.0, 1.35], "carbon");
  // Floor: full-length but narrower than the tire inner edges, so it never
  // clips a wheel.
  box([1.3, 0.08, 3.7], [0, -0.36, 0], "carbon");
  // Front wing ahead of the tip on two pylons, endplates in livery.
  box([1.8, 0.06, 0.45], [0, -0.3, -hz - 0.05], "carbon");
  for (const side of [-1, 1] as const) {
    box([0.08, 0.12, 0.2], [side * 0.15, -0.24, -hz + 0.1], "carbon");
    box([0.05, 0.28, 0.5], [side * 0.9, -0.2, -hz - 0.05], "livery");
  }
  // Rear wing assembly: main plane (the moving flap - see flap above),
  // endplates, pylons, beam wing reaching the endplates on both sides.
  box([1.5, 0.06, 0.4], [0, 0.62, hz - 0.15], "carbon", true);
  for (const side of [-1, 1] as const) {
    box([0.05, 0.5, 0.5], [side * 0.75, 0.5, hz - 0.15], "livery");
    box([0.08, 0.3, 0.25], [side * 0.1, 0.45, hz - 0.2], "carbon");
  }
  box([1.56, 0.05, 0.3], [0, 0.05, hz - 0.1], "carbon");
  // Diffuser ramp under the rear.
  box([1.2, 0.15, 0.4], [0, -0.28, hz - 0.15], "carbon");
  // Mirrors on stalks rooted in the sidepods, T-cam pod on the airbox,
  // rain light half-embedded in the tail.
  for (const side of [-1, 1] as const) {
    box([0.04, 0.2, 0.04], [side * 0.55, 0.2, 0.0], "carbon");
    box([0.16, 0.06, 0.08], [side * 0.62, 0.32, 0.0], "livery");
  }
  box([0.12, 0.08, 0.2], [0, 0.79, 0.85], "carbon");
  box([0.1, 0.12, 0.05], [0, 0.35, hz + 0.02], "light");
  // Visor strip on the helmet's forward face.
  box([0.2, 0.08, 0.05], [0, 0.5, 0.13], "visor");
  // Halo mounts: front pylon plus two rears, rooting the ring in bodywork.
  box([0.08, 0.16, 0.1], [0, 0.4, 0.0], "carbon");
  for (const side of [-1, 1] as const) {
    box([0.06, 0.14, 0.08], [side * 0.2, 0.4, 0.52], "carbon");
  }
  // Suspension arms from bodywork to each wheel station, upper and lower -
  // inner tips land inside bodywork, outer tips inside the tire sidewalls.
  for (const { x, z } of wheelStations) {
    const side = x < 0 ? -1 : 1;
    for (const y of [-0.12, -0.3]) {
      box([0.72, 0.05, 0.08], [side * 0.49, y, z], "carbon");
    }
  }

  return {
    panels,
    helmet: { radius: 0.16, position: [0, 0.47, 0.3] },
    halo: { radius: 0.3, tube: 0.045, position: [0, 0.5, 0.3] },
  };
}

/** Open angle of the DRS-style flap: trailing edge up, like the real thing. */
export const FLAP_OPEN_RAD = -0.5;
/** Flap actuator speed - snaps open/shut in about a fifth of a second. */
export const FLAP_RATE_RAD_S = 2.5;

/** Rate-limited step toward the flap target: no overshoot, dt-safe. */
export function stepFlapAngle(current: number, target: number, dtSeconds: number): number {
  const remaining = target - current;
  const step = Math.sign(remaining) * Math.min(Math.abs(remaining), FLAP_RATE_RAD_S * Math.max(0, dtSeconds));
  return current + step;
}
