// Plan section 11 (retro-modern) + the garage livery (lib/race/roster.ts):
// the F1 car body as data, not JSX. The vocabulary is still stepped boxes -
// no sculpted meshes, no assets - but the assembly now reads as a modern F1
// car: a three-element front wing with endplates, footplates and pylons; a
// tapered nose; monocoque and cockpit with headrest pads; sidepods with
// inlets, shoulder stripes, cooling louvres and a rear taper; a floor with
// edge fences; a diffuser with strakes; airbox, engine cover, shark fin,
// roll hoop and T-cam; a two-element rear wing (main plane + the DRS flap)
// with endplates, swan-neck pylons and a beam wing; the halo ring; mirrors;
// and three suspension links per wheel station. Plus a sphere helmet.
//
// Dimensions key off the physics chassis half-extents and wheel stations
// passed in, so the visuals can never silently outgrow the colliders they
// dress; origin, axes and units match the RigidBody frame (+x right, +y up,
// -z forward, meters).
//
// Nothing here touches physics: every panel is scenery inside the visual
// group, while the solid colliders stay exactly the chassis cuboid plus the
// (mesh-less) raycast wheels.
//
// Consumer: app/race/CarBodyMesh.tsx renders this for every car on the
// grid, the ghost and the garage showroom; tests/carBody.test.ts asserts
// the envelope, the mirror symmetry, the tire clearances and the merge
// output panel by panel.
//
// Joinery rule: abutting boxes always interpenetrate by a centimeter or
// two, never merely touch - touching faces are coplanar quads that z-fight,
// while an overlap reads as one merged solid. Paint stripes sink into the
// bodywork they sit on for the same reason, and poking a stripe's edge out
// of both faces of a thin fin is what makes it read from either side.
//
// Budget rule: ~90 boxes cost one merged draw call per paint role per car
// (see mergePanelBoxes) instead of ~90 meshes, and the merged buffers are
// per role, not per car - ten static geometries for a 21-car grid.

export type BodyPanelColor =
  | "livery"
  | "accent"
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
  /** The one moving part: the rear-wing top element (the DRS flap),
   * rendered by app/race/CarBodyMesh.tsx inside a pivot group at its
   * leading edge and rotated open in low-drag mode. */
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

/** Suspension links per wheel station: [height, length] for the upper and
 * lower wishbones plus the track rod, all reaching from bodywork into the
 * tire sidewalls (see the clearance test - the tips are the only bodywork
 * allowed to touch a tire cylinder). */
const SUSPENSION_LINKS: [number, number][] = [
  [0.03, 0.66],
  [-0.14, 0.7],
  [-0.32, 0.72],
];

/** Driver's helmet: the sphere the halo ring sits around. */
const HELMET_RADIUS = 0.16;
const HELMET_POSITION: [number, number, number] = [0, 0.47, 0.3];

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
  // One size, one station, both sides: mirroring by construction is also
  // what keeps the symmetry test exact rather than approximate.
  const pair = (
    size: [number, number, number],
    x: number,
    y: number,
    z: number,
    color: BodyPanelColor
  ) => {
    for (const side of [-1, 1] as const) box(size, [side * x, y, z], color);
  };

  // Longitudinal extremes hang off hz (the chassis half length): the front
  // wing sits at the very edge of the overhang the envelope test allows
  // (hz + 0.3), and the tail stack stays inside hz + 0.1. Interior spans are
  // plain literals - they do not move when the chassis length changes.

  // Front wing: three stacked elements, endplates with footplates and top
  // strakes, on a pair of pylons under the nose tip.
  box([2.0, 0.05, 0.5], [0, -0.31, -(hz + 0.04)], "carbon");
  box([1.9, 0.045, 0.32], [0, -0.27, -(hz - 0.09)], "carbon");
  box([1.7, 0.04, 0.22], [0, -0.225, -(hz - 0.21)], "accent");
  pair([0.05, 0.32, 0.58], 0.95, -0.18, -(hz - 0.02), "livery");
  pair([0.14, 0.04, 0.5], 0.97, -0.315, -(hz - 0.03), "carbon");
  pair([0.045, 0.09, 0.44], 0.95, -0.05, -(hz - 0.07), "accent");
  pair([0.07, 0.2, 0.3], 0.13, -0.24, -(hz - 0.01), "carbon");

  // Nose: three shrinking steps from the tip back into the monocoque, with
  // the paint stripe riding the top of the spine.
  box([0.34, 0.18, 0.6], [0, -0.13, -(hz - 0.26)], "livery");
  box([0.52, 0.28, 0.7], [0, -0.07, -(hz - 0.75)], "livery");
  box([0.7, 0.38, 0.8], [0, -0.01, -(hz - 1.4)], "livery");
  box([0.1, 0.06, 0.9], [0, 0.08, -(hz - 1.4)], "accent");

  // Monocoque tub, cockpit deck, dash, headrest pads, helmet visor strip.
  box([1.0, 0.56, 1.7], [0, 0.04, 0.25], "livery");
  box([0.66, 0.1, 1.05], [0, 0.34, 0.28], "carbon");
  box([0.5, 0.06, 0.5], [0, 0.42, -0.28], "carbon");
  pair([0.16, 0.14, 0.34], 0.25, 0.4, 0.32, "carbon");
  box([0.2, 0.08, 0.05], [0, 0.5, 0.13], "visor");

  // Sidepods: inlet lip and mouth, undercut above the floor edge, shoulder
  // stripe, cooling louvre block, rear taper and a forward vane.
  pair([0.44, 0.4, 1.25], 0.6, -0.08, 0.28, "livery");
  pair([0.46, 0.1, 0.16], 0.6, 0.14, -0.4, "carbon");
  pair([0.36, 0.34, 0.14], 0.6, -0.06, -0.42, "carbon");
  pair([0.34, 0.2, 1.1], 0.62, -0.28, 0.3, "carbon");
  pair([0.36, 0.06, 0.55], 0.6, 0.14, 0.5, "accent");
  pair([0.3, 0.05, 0.45], 0.58, 0.17, 0.95, "carbon");
  pair([0.3, 0.3, 0.42], 0.5, -0.05, 1.18, "carbon");
  pair([0.06, 0.36, 0.36], 0.62, -0.16, -0.8, "livery");

  // Floor, leading ramp, edge fences, diffuser ramp with two strake pairs.
  box([1.32, 0.07, 3.7], [0, -0.36, 0.0], "carbon");
  box([1.12, 0.06, 0.55], [0, -0.325, -(hz - 0.15)], "carbon");
  pair([0.05, 0.12, 1.7], 0.64, -0.38, -(hz - 1.7), "carbon");
  box([1.16, 0.16, 0.45], [0, -0.3, hz - 0.2], "carbon");
  pair([0.05, 0.2, 0.4], 0.2, -0.26, hz - 0.2, "carbon");
  pair([0.05, 0.2, 0.4], 0.48, -0.26, hz - 0.2, "carbon");

  // Engine cover tapering to a tail cap, airbox and its mouth, shark fin
  // with a paint stripe, roll hoop, T-cam, onboard cameras on the airbox,
  // gearbox block, and the crash structure the rain light sits in.
  box([0.6, 0.48, 1.35], [0, 0.18, 0.95], "livery");
  box([0.44, 0.36, 0.55], [0, 0.18, 1.72], "livery");
  box([0.3, 0.26, 0.36], [0, 0.16, hz - 0.1], "carbon");
  box([0.42, 0.44, 0.5], [0, 0.54, 0.75], "livery");
  box([0.3, 0.3, 0.14], [0, 0.52, 0.46], "carbon");
  box([0.06, 0.5, 0.95], [0, 0.42, 1.3], "livery");
  box([0.05, 0.32, 0.5], [0, 0.46, 1.82], "carbon");
  box([0.075, 0.1, 0.75], [0, 0.5, 1.28], "accent");
  box([0.2, 0.14, 0.24], [0, 0.8, 0.75], "carbon");
  box([0.12, 0.08, 0.2], [0, 0.9, 0.75], "carbon");
  pair([0.06, 0.12, 0.06], 0.19, 0.74, 0.75, "carbon");
  box([0.44, 0.4, 0.8], [0, 0.02, 1.25], "carbon");
  box([0.26, 0.24, 0.5], [0, 0.2, hz - 0.17], "carbon");
  box([0.12, 0.14, 0.06], [0, 0.26, hz], "light");

  // Rear wing: main plane (static) plus the DRS flap - the one moving
  // panel - between endplates with top strakes and leading canards, on
  // swan-neck pylons, with a two-element beam wing underneath.
  box([1.5, 0.05, 0.42], [0, 0.5, hz - 0.15], "carbon");
  box([1.42, 0.05, 0.3], [0, 0.66, hz - 0.15], "accent", true);
  pair([0.05, 0.56, 0.52], 0.78, 0.53, hz - 0.18, "livery");
  pair([0.045, 0.08, 0.52], 0.78, 0.84, hz - 0.2, "accent");
  pair([0.06, 0.18, 0.18], 0.78, 0.63, hz - 0.51, "livery");
  pair([0.08, 0.28, 0.18], 0.14, 0.4, hz - 0.23, "carbon");
  box([1.52, 0.05, 0.34], [0, 0.16, hz - 0.12], "carbon");
  box([1.56, 0.045, 0.28], [0, 0.05, hz - 0.1], "carbon");

  // Halo front pylon and rear mounts, mirrors on stalks rooted in the
  // sidepods, then the suspension links per wheel station.
  box([0.08, 0.2, 0.1], [0, 0.42, -0.05], "carbon");
  pair([0.06, 0.16, 0.09], 0.2, 0.42, 0.5, "carbon");
  pair([0.04, 0.22, 0.04], 0.55, 0.22, -0.12, "carbon");
  pair([0.18, 0.07, 0.1], 0.62, 0.36, -0.12, "livery");
  for (const { x, z } of wheelStations) {
    const side = x < 0 ? -1 : 1;
    for (const [y, length] of SUSPENSION_LINKS) {
      box([length, 0.05, 0.08], [side * 0.47, y, z], "carbon");
    }
  }

  return {
    panels,
    helmet: { radius: HELMET_RADIUS, position: HELMET_POSITION },
    halo: { radius: 0.3, tube: 0.045, position: [0, 0.5, 0.3] },
  };
}

// Active aero (plan section 5 + the E-key DRS toggle in useDriveInput): the
// flap element parks at a real wing's angle of attack, and DRS adds the
// pivot rotation on top of it.
/** Park angle of the shut DRS flap: trailing edge already up, like a real
 * rear-wing element (applied to the mesh inside the pivot group). */
export const FLAP_CLOSED_INCLINE_RAD = -0.3;
/** Pivot rotation added when DRS deploys (see Car.tsx's low-drag mode) -
 * with the park angle that is about 49 degrees of travel. */
export const FLAP_OPEN_RAD = -0.55;
/** Flap actuator speed - snaps open/shut in about a fifth of a second. */
export const FLAP_RATE_RAD_S = 2.5;

/** Rate-limited step toward the flap target: no overshoot, dt-safe. */
export function stepFlapAngle(current: number, target: number, dtSeconds: number): number {
  const remaining = target - current;
  const step = Math.sign(remaining) * Math.min(Math.abs(remaining), FLAP_RATE_RAD_S * Math.max(0, dtSeconds));
  return current + step;
}

/** Merged geometry data for a group of boxes: exactly the typed arrays a
 * THREE.BufferGeometry needs, as plain math so this module stays three-free
 * and the merge is unit-testable on its own. */
export interface MergedBoxes {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint16Array;
}

/** The six faces of a unit box: a counter-clockwise corner ring (seen from
 * outside, the winding three.js treats as front-facing) plus that face's
 * outward normal. Corners are +/-1 so the caller scales by half extents. */
const BOX_FACES: ReadonlyArray<{
  normal: readonly [number, number, number];
  corners: ReadonlyArray<readonly [number, number, number]>;
}> = [
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

/**
 * Flattens panels into one buffer: 24 vertices (6 faces x 4 corners) and 36
 * indices per box, so a whole paint role draws as a single mesh. Vertices
 * are not shared between faces, which is what keeps per-face normals crisp
 * on a merged box. Uint16 indices cover 65535 vertices - about 2700 boxes,
 * an order of magnitude past the widest role here.
 */
export function mergePanelBoxes(panels: BodyPanel[]): MergedBoxes {
  const positions = new Float32Array(panels.length * 24 * 3);
  const normals = new Float32Array(panels.length * 24 * 3);
  const indices = new Uint16Array(panels.length * 36);
  let vertex = 0;
  let index = 0;
  for (const panel of panels) {
    const [sx, sy, sz] = panel.size;
    const [cx, cy, cz] = panel.position;
    for (const face of BOX_FACES) {
      const start = vertex;
      const [nx, ny, nz] = face.normal;
      for (const [ox, oy, oz] of face.corners) {
        positions[vertex * 3] = cx + (ox * sx) / 2;
        positions[vertex * 3 + 1] = cy + (oy * sy) / 2;
        positions[vertex * 3 + 2] = cz + (oz * sz) / 2;
        normals[vertex * 3] = nx;
        normals[vertex * 3 + 1] = ny;
        normals[vertex * 3 + 2] = nz;
        vertex++;
      }
      indices[index++] = start;
      indices[index++] = start + 1;
      indices[index++] = start + 2;
      indices[index++] = start;
      indices[index++] = start + 2;
      indices[index++] = start + 3;
    }
  }
  return { positions, normals, indices };
}

/** Neutral silver for cars whose livery has no second paint (see
 * computeAccentColor). */
export const DEFAULT_ACCENT_COLOR = "#e8e9ec";

/**
 * The second livery color: a team's secondary paint when the caller has one
 * (see page.tsx's roster pick), otherwise derived from the primary by
 * pulling 55% toward whichever end keeps the stripe readable - dark paints
 * lighten, very light paints darken. Unparseable input falls back to a
 * neutral silver rather than throwing, the same unknown-tolerant contract
 * as parseTeamId.
 */
export function computeAccentColor(primary: string): string {
  const rgb = parseHexColor(primary);
  if (!rgb) return DEFAULT_ACCENT_COLOR;
  const [r, g, b] = rgb;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const target = luminance > 0.62 ? 0 : 255;
  const mix = 0.55;
  return toHexColor([
    r + (target - r) * mix,
    g + (target - g) * mix,
    b + (target - b) * mix,
  ]);
}

/** "#rgb" / "#rrggbb" -> channels, or null when the string is not a color. */
function parseHexColor(value: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const digits =
    match[1].length === 3 ? match[1].split("").map((c) => c + c).join("") : match[1];
  return [
    parseInt(digits.slice(0, 2), 16),
    parseInt(digits.slice(2, 4), 16),
    parseInt(digits.slice(4, 6), 16),
  ];
}

function toHexColor(rgb: readonly number[]): string {
  return `#${rgb
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")
    )
    .join("")}`;
}
