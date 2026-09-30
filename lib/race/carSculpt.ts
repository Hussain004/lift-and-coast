// The F1 car as sculpted low-poly geometry (the previous generation was ~90
// axis-aligned boxes). Still procedural, still no assets: lofted
// superellipse sections for the nose/monocoque/engine cover, undercut
// coke-bottle sidepods and the airbox; cambered airfoil elements for both
// wings and the beam wing; profiled endplates, a shaped floor, a tube halo,
// wishbone suspension and rounded tyres.
//
// Draw-call budget is the point of the layout: colours are baked in as
// vertex colours, so a whole car is two body meshes (glossy paint, matte
// carbon), the active-aero flap and four wheels - and a 20-car grid shares one set
// of geometry per livery. Frame and units match the RigidBody: +x right,
// +y up, -z forward, meters, wheel stations from CAR_WHEELS.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CAR_WHEELS } from "../physics/vehicle";
import { FLAP_CLOSED_INCLINE_RAD } from "./carBody";

type P2 = [number, number];
type P3 = [number, number, number];

export const CARBON_COLOR = "#17181b";
export const VISOR_COLOR = "#0b0e12";
export const TIRE_COLOR = "#141414";
export const RIM_COLOR = "#2b2d31";
/** Sidewall stripe per compound, as painted on the real tyres. */
export const COMPOUND_STRIPE_COLOR = {
  soft: "#e3322b",
  medium: "#f2c230",
  hard: "#f4f4f4",
  intermediate: "#2fb24a",
  wet: "#2f7fe0",
} as const;
export const HELMET_COLOR = "#f2f2f2";
export const LIGHT_COLOR = "#ff2a2a";

/** Active-aero flap: pivot (its leading edge) in the car frame, and chord/span. */
export const FLAP_PIVOT: P3 = [0, 0.52, 1.8];
export const FLAP_CHORD = 0.26;
export const FLAP_SPAN = 1.4;

export const WHEEL_RADIUS = 0.34;
/** Front tyre width; the driven rears are wider, as on the real cars. */
export const TIRE_WIDTH = 0.3;
export const REAR_TIRE_WIDTH = 0.38;

// ---------------------------------------------------------------- helpers

function colorize(geometry: THREE.BufferGeometry, color: string): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** Non-indexed, position/normal/color only - the common shape mergeGeometries needs. */
function normalize(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "color") g.deleteAttribute(name);
  }
  if (!g.getAttribute("normal")) g.computeVertexNormals();
  return g;
}

/**
 * Flips any triangle whose normal points toward `inside(triangleCentroid)`,
 * so every face is outward-facing under FrontSide materials whatever order
 * the builder happened to emit it in.
 */
function orientOutward(positions: number[], inside: (c: THREE.Vector3) => THREE.Vector3): void {
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i);
    b.fromArray(positions, i + 3);
    c.fromArray(positions, i + 6);
    n.subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    centroid.copy(a).add(b).add(c).divideScalar(3);
    const out = centroid.clone().sub(inside(centroid));
    if (n.dot(out) < 0) {
      for (let k = 0; k < 3; k++) {
        const t = positions[i + 3 + k];
        positions[i + 3 + k] = positions[i + 6 + k];
        positions[i + 6 + k] = t;
      }
    }
  }
}

function fromTriangles(positions: number[], smooth: boolean): THREE.BufferGeometry {
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (smooth) {
    // Weld coincident vertices so the normals average across faces.
    geometry.deleteAttribute("normal");
    geometry = mergeVerticesLite(geometry);
    geometry.computeVertexNormals();
    return geometry.toNonIndexed();
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Position-only vertex welding (BufferGeometryUtils.mergeVertices without
 * the attribute bookkeeping this module doesn't need). */
function mergeVerticesLite(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geometry.getAttribute("position");
  const map = new Map<string, number>();
  const unique: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`;
    let at = map.get(key);
    if (at === undefined) {
      at = unique.length / 3;
      map.set(key, at);
      unique.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    index.push(at);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(unique, 3));
  out.setIndex(index);
  return out;
}

interface Section {
  z: number;
  /** Section centre. */
  cx?: number;
  cy: number;
  w: number;
  h: number;
  /** Superellipse exponent: 2 = ellipse, 4+ = rounded box. */
  n?: number;
  /** Narrows the lower half (sidepod undercut), 0..1. */
  undercut?: number;
}

// Ring resolution and airfoil sampling: the far-away rival body is the same
// design at half the tessellation (see buildFarCarGeometry).
let RING = 20;
let FOIL_STEPS = 7;

function ringPoint(s: Section, k: number): P3 {
  const t = (2 * Math.PI * k) / RING;
  const c = Math.cos(t);
  const sn = Math.sin(t);
  const e = 2 / (s.n ?? 3);
  const ux = Math.sign(c) * Math.abs(c) ** e;
  const uy = Math.sign(sn) * Math.abs(sn) ** e;
  const under = uy < 0 ? 1 - (s.undercut ?? 0) * Math.abs(uy) : 1;
  return [(s.cx ?? 0) + (s.w / 2) * ux * under, s.cy + (s.h / 2) * uy, s.z];
}

/** Smooth-shaded loft through sections ordered along z, capped both ends. */
function loft(sections: Section[], caps = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const push = (...ps: P3[]) => {
    for (const p of ps) pos.push(p[0], p[1], p[2]);
  };
  for (let i = 0; i < sections.length - 1; i++) {
    for (let k = 0; k < RING; k++) {
      const a = ringPoint(sections[i], k);
      const b = ringPoint(sections[i], k + 1);
      const c = ringPoint(sections[i + 1], k + 1);
      const d = ringPoint(sections[i + 1], k);
      push(a, b, c);
      push(a, c, d);
    }
  }
  for (const s of caps ? [sections[0], sections[sections.length - 1]] : []) {
    const center: P3 = [s.cx ?? 0, s.cy, s.z];
    for (let k = 0; k < RING; k++) {
      push(center, ringPoint(s, k), ringPoint(s, k + 1));
    }
  }
  const first = sections[0];
  const last = sections[sections.length - 1];
  const axisAt = (z: number): { x: number; y: number } => {
    for (let i = 0; i < sections.length - 1; i++) {
      const a = sections[i];
      const b = sections[i + 1];
      if (z >= Math.min(a.z, b.z) - 1e-6 && z <= Math.max(a.z, b.z) + 1e-6) {
        const t = (z - a.z) / (b.z - a.z || 1);
        return { x: (a.cx ?? 0) + ((b.cx ?? 0) - (a.cx ?? 0)) * t, y: a.cy + (b.cy - a.cy) * t };
      }
    }
    const s = z < first.z ? first : last;
    return { x: s.cx ?? 0, y: s.cy };
  };
  const zMid = (first.z + last.z) / 2;
  orientOutward(pos, (c) => {
    // Caps face along the axis; walls face away from the local axis.
    const cap = c.z <= first.z + 1e-4 || c.z >= last.z - 1e-4;
    const axis = axisAt(c.z);
    return cap ? new THREE.Vector3(axis.x, axis.y, zMid) : new THREE.Vector3(axis.x, axis.y, c.z);
  });
  return fromTriangles(pos, true);
}

/** The loft's cross-section at `z`, interpolated between its stations. */
function sectionAt(sections: Section[], z: number): Section {
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i];
    const b = sections[i + 1];
    if (z >= a.z - 1e-9 && z <= b.z + 1e-9) {
      const t = (z - a.z) / (b.z - a.z || 1);
      const l = (x: number, y: number): number => x + (y - x) * t;
      return {
        z,
        cx: l(a.cx ?? 0, b.cx ?? 0),
        cy: l(a.cy, b.cy),
        w: l(a.w, b.w),
        h: l(a.h, b.h),
        n: l(a.n ?? 3, b.n ?? 3),
        undercut: l(a.undercut ?? 0, b.undercut ?? 0),
      };
    }
  }
  return sections[z < sections[0].z ? 0 : sections.length - 1];
}

/**
 * A painted band hugging a loft between two stations: the same surface, a
 * hair proud of it, so the stripe reads as livery rather than a floating
 * plate. `steps` intermediate rings keep it on a curving surface.
 */
function band(sections: Section[], z0: number, z1: number, grow = 0.012, steps = 2): THREE.BufferGeometry {
  const ring: Section[] = [];
  for (let i = 0; i <= steps; i++) {
    const s = sectionAt(sections, z0 + ((z1 - z0) * i) / steps);
    ring.push({ ...s, w: s.w + grow * 2, h: s.h + grow * 2 });
  }
  return loft(ring, false);
}

/**
 * A flat-shaded prism: a closed 2D profile swept between two depths along
 * one axis. `place(u, v, w)` maps profile coords + depth to the car frame.
 */
function prism(profile: P2[], w0: number, w1: number, place: (u: number, v: number, w: number) => P3): THREE.BufferGeometry {
  const pos: number[] = [];
  const push = (...ps: P3[]) => {
    for (const p of ps) pos.push(p[0], p[1], p[2]);
  };
  const m = profile.length;
  for (let i = 0; i < m; i++) {
    const [u0, v0] = profile[i];
    const [u1, v1] = profile[(i + 1) % m];
    push(place(u0, v0, w0), place(u1, v1, w0), place(u1, v1, w1));
    push(place(u0, v0, w0), place(u1, v1, w1), place(u0, v0, w1));
  }
  const contour = profile.map(([u, v]) => new THREE.Vector2(u, v));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const w of [w0, w1]) {
    for (const [a, b, c] of tris) {
      push(place(...profile[a], w), place(...profile[b], w), place(...profile[c], w));
    }
  }
  const cu = profile.reduce((s, p) => s + p[0], 0) / m;
  const cv = profile.reduce((s, p) => s + p[1], 0) / m;
  const center = new THREE.Vector3(...place(cu, cv, (w0 + w1) / 2));
  const wMid = (w0 + w1) / 2;
  orientOutward(pos, (c) => {
    // Walls: away from the profile centre at the triangle's own depth.
    const cap0 = new THREE.Vector3(...place(cu, cv, w0));
    const cap1 = new THREE.Vector3(...place(cu, cv, w1));
    const depthAxis = cap1.clone().sub(cap0);
    const along = c.clone().sub(center).dot(depthAxis) / Math.max(1e-9, depthAxis.lengthSq());
    const onCap = Math.abs(Math.abs(along) - 0.5) < 1e-3;
    return onCap ? center : new THREE.Vector3(...place(cu, cv, wMid + along * (w1 - w0)));
  });
  return fromTriangles(pos, false);
}

/**
 * A cambered airfoil section (points (z, y) around the chord), leading edge
 * at `le`, pitched trailing-edge-up by `pitch` radians. Inverted camber, as
 * on a downforce wing.
 */
function airfoil(chord: number, thickness: number, camber: number, pitch: number, le: P2): P2[] {
  const n = FOIL_STEPS;
  const upper: P2[] = [];
  const lower: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const x = (1 - Math.cos((Math.PI * i) / n)) / 2;
    const t = 5 * thickness * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
    const yc = -camber * 4 * x * (1 - x);
    upper.push([x * chord, (yc + t) * chord]);
    lower.push([x * chord, (yc - t) * chord]);
  }
  const loop = [...upper, ...lower.reverse().slice(1, -1)];
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return loop.map(([u, v]) => [le[0] + u * cp - v * sp, le[1] + u * sp + v * cp]);
}

/** A wing element spanning ±span/2 across x. */
function wing(chord: number, span: number, le: P2, pitch: number, thickness = 0.1, camber = 0.05): THREE.BufferGeometry {
  return prism(airfoil(chord, thickness, camber, pitch, le), -span / 2, span / 2, (z, y, x) => [x, y, z]);
}

/** A thin plate in the (z, y) plane at x in [x0, x1]. */
function sidePlate(profile: P2[], x0: number, x1: number): THREE.BufferGeometry {
  return prism(profile, x0, x1, (z, y, x) => [x, y, z]);
}

function mirrorX(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  // Mirroring flips winding: swap two vertices of every triangle.
  const pos = g.getAttribute("position");
  const nor = g.getAttribute("normal");
  for (let i = 0; i < pos.count; i += 3) {
    for (const attr of [pos, nor]) {
      if (!attr) continue;
      const bx = attr.getX(i + 1), by = attr.getY(i + 1), bz = attr.getZ(i + 1);
      attr.setXYZ(i + 1, attr.getX(i + 2), attr.getY(i + 2), attr.getZ(i + 2));
      attr.setXYZ(i + 2, bx, by, bz);
    }
  }
  return g;
}

function pair(geometry: THREE.BufferGeometry): THREE.BufferGeometry[] {
  const g = normalize(geometry);
  return [g, mirrorX(g)];
}

/** A thin rod between two points (suspension links, mirror stalks). */
function rod(a: P3, b: P3, radius: number): THREE.BufferGeometry {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const length = va.distanceTo(vb);
  const g = new THREE.CylinderGeometry(radius, radius, length, 5, 1, true);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    vb.clone().sub(va).normalize()
  );
  g.applyQuaternion(q);
  const mid = va.add(vb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

function box(size: P3, at: P3): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(...size);
  g.translate(...at);
  return g;
}

// ------------------------------------------------------------------ parts

const WHEEL_Z = 1.3;

/** Fine detail (bands, fences, brake ducts) the far-away version leaves out. */
let FAR = false;

// Nose, monocoque and engine cover: one continuous loft.
const MONOCOQUE: Section[] = [
  { z: -2.14, cy: -0.165, w: 0.17, h: 0.11, n: 2.4 },
  { z: -1.9, cy: -0.15, w: 0.22, h: 0.15, n: 2.6 },
  { z: -1.4, cy: -0.1, w: 0.32, h: 0.22, n: 2.8 },
  { z: -0.9, cy: -0.04, w: 0.46, h: 0.33, n: 3 },
  { z: -0.45, cy: -0.02, w: 0.64, h: 0.46, n: 3.2 },
  { z: 0.0, cy: -0.03, w: 0.72, h: 0.56, n: 3.6 },
  { z: 0.5, cy: -0.01, w: 0.74, h: 0.6, n: 3.6 },
  { z: 0.9, cy: 0.04, w: 0.62, h: 0.64, n: 3.2 },
  { z: 1.35, cy: 0.06, w: 0.42, h: 0.48, n: 3 },
  { z: 1.75, cy: 0.1, w: 0.26, h: 0.3, n: 2.8 },
  { z: 2.02, cy: 0.12, w: 0.14, h: 0.18, n: 2.6 },
];

// Sidepods: undercut inlets that swell into the body then taper away into
// the coke-bottle. They overlap the monocoque so the two read as one shape.
const SIDEPOD: Section[] = [
  { z: -0.62, cx: 0.5, cy: -0.09, w: 0.4, h: 0.34, n: 3, undercut: 0.4 },
  { z: -0.4, cx: 0.52, cy: -0.07, w: 0.5, h: 0.42, n: 3.4, undercut: 0.4 },
  { z: 0.15, cx: 0.52, cy: -0.07, w: 0.54, h: 0.42, n: 3.4, undercut: 0.45 },
  { z: 0.65, cx: 0.46, cy: -0.11, w: 0.42, h: 0.34, n: 3, undercut: 0.35 },
  { z: 1.05, cx: 0.36, cy: -0.18, w: 0.24, h: 0.2, n: 2.8 },
  { z: 1.3, cx: 0.28, cy: -0.22, w: 0.1, h: 0.1, n: 2.6 },
];

const WHITE_STRIPE = "#f4f4f4";

function paintParts(livery: string, accent: string, frontWing: THREE.BufferGeometry[], rearWing: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const L = (g: THREE.BufferGeometry) => colorize(normalize(g), livery);
  const A = (g: THREE.BufferGeometry) => colorize(normalize(g), accent);
  const parts: THREE.BufferGeometry[] = [];
  parts.push(L(loft(MONOCOQUE)));
  // Airbox above and behind the driver's head, sweeping down the spine.
  parts.push(
    L(
      loft([
        { z: 0.5, cy: 0.52, w: 0.24, h: 0.22, n: 2.8 },
        { z: 0.75, cy: 0.52, w: 0.3, h: 0.28, n: 3 },
        { z: 1.1, cy: 0.4, w: 0.22, h: 0.22, n: 2.8 },
        { z: 1.5, cy: 0.24, w: 0.1, h: 0.1, n: 2.6 },
      ])
    )
  );
  // Shark fin.
  parts.push(
    L(
      sidePlate(
        [
          [1.05, 0.4],
          [1.9, 0.24],
          [1.92, 0.34],
          [1.25, 0.52],
        ],
        -0.01,
        0.01
      )
    )
  );
  parts.push(...pair(loft(SIDEPOD)).map((g) => colorize(g, livery)));
  // Livery: a tip band and a white pinstripe round the nose, an accent hoop
  // round each sidepod, another over the engine cover, and the cover stripe.
  parts.push(A(band(MONOCOQUE, -2.14, -1.9, 0.006, 1)));
  if (!FAR) {
    parts.push(colorize(normalize(band(MONOCOQUE, -1.5, -1.44, 0.008, 1)), WHITE_STRIPE));
    parts.push(...pair(band(SIDEPOD, -0.2, 0.05, 0.01, 2)).map((g) => colorize(g, accent)));
    parts.push(...pair(band(SIDEPOD, 0.1, 0.15, 0.01, 1)).map((g) => colorize(g, WHITE_STRIPE)));
    parts.push(A(band(MONOCOQUE, 1.1, 1.3, 0.008, 2)));
  }
  parts.push(A(box([0.08, 0.02, 0.9], [0, 0.34, 1.0])));
  // Front wing endplates and rear wing endplates (their own meshes, see
  // CarGeometry: the player's car can lose them).
  frontWing.push(
    ...pair(
      sidePlate(
        [
          [-2.3, -0.37],
          [-1.72, -0.37],
          [-1.72, -0.13],
          [-1.98, -0.04],
          [-2.3, -0.2],
        ],
        0.93,
        0.965
      )
    ).map((g) => colorize(g, livery))
  );
  rearWing.push(
    ...pair(
      sidePlate(
        [
          [1.5, 0.24],
          [2.06, 0.22],
          [2.14, 0.4],
          [2.12, 0.68],
          [1.98, 0.74],
          [1.72, 0.72],
          [1.56, 0.56],
        ],
        0.72,
        0.755
      )
    ).map((g) => colorize(g, livery))
  );
  // Accent cap along the top of each rear endplate.
  rearWing.push(...pair(sidePlate([[1.72, 0.7], [1.98, 0.72], [2.12, 0.66], [2.12, 0.56], [1.96, 0.62], [1.72, 0.6]], 0.716, 0.759)).map((g) => colorize(g, accent)));
  // Mirrors: a housing on a stalk.
  parts.push(...pair(box([0.17, 0.07, 0.1], [0.62, 0.34, -0.15])).map((g) => colorize(g, livery)));
  // Helmet and the rain light ride the paint mesh (glossy).
  const helmet = new THREE.SphereGeometry(0.16, FAR ? 10 : 16, FAR ? 8 : 12);
  helmet.translate(0, 0.42, 0.3);
  parts.push(colorize(normalize(helmet), HELMET_COLOR));
  parts.push(colorize(normalize(box([0.12, 0.12, 0.05], [0, 0.26, 2.04])), LIGHT_COLOR));
  return parts;
}

function carbonParts(frontWing: THREE.BufferGeometry[], rearWing: THREE.BufferGeometry[]): THREE.BufferGeometry[] {
  const C = (g: THREE.BufferGeometry) => colorize(normalize(g), CARBON_COLOR);
  const parts: THREE.BufferGeometry[] = [];
  // Floor: plan outline clear of all four tyres, with a diffuser ramp.
  const half: P2[] = [
    [0.3, -1.55],
    [0.55, -0.95],
    [0.78, -0.72],
    [0.8, 0.75],
    [0.62, 0.95],
    [0.56, 1.95],
  ];
  const outline: P2[] = [...half, ...half.map(([x, z]) => [-x, z] as P2).reverse()];
  parts.push(C(prism(outline, -0.4, -0.36, (x, z, y) => [x, y, z])));
  parts.push(C(prism([[1.6, -0.36], [2.05, -0.36], [2.05, -0.2]], -0.55, 0.55, (z, y, x) => [x, y, z])));
  // Front wing: four elements; rear wing main plane; beam wing.
  frontWing.push(C(wing(0.42, 1.86, [-2.28, -0.33], 0.05)));
  frontWing.push(C(wing(0.26, 1.8, [-2.0, -0.28], 0.28)));
  frontWing.push(C(wing(0.18, 1.7, [-1.86, -0.21], 0.5)));
  if (!FAR) frontWing.push(C(wing(0.12, 1.5, [-1.76, -0.12], 0.72, 0.08)));
  rearWing.push(C(wing(0.36, 1.44, [1.52, 0.4], 0.16)));
  rearWing.push(C(wing(0.24, 1.2, [1.72, 0.14], 0.12)));
  // Swan-neck pylons, front wing pylons, halo, airbox intake, cockpit rim.
  rearWing.push(...pair(sidePlate([[1.62, 0.1], [1.78, 0.1], [1.74, 0.44], [1.64, 0.44]], 0.1, 0.13)).map((g) => colorize(g, CARBON_COLOR)));
  for (const x of FAR ? [0.1] : [0.1, 0.34]) {
    frontWing.push(...pair(sidePlate([[-2.1, -0.32], [-1.9, -0.32], [-1.9, -0.18], [-2.02, -0.16]], x, x + 0.03)).map((g) => colorize(g, CARBON_COLOR)));
  }
  const halo = new THREE.CatmullRomCurve3(
    [
      [-0.24, 0.3, 0.64],
      [-0.28, 0.55, 0.42],
      [-0.21, 0.61, 0.1],
      [0, 0.61, -0.03],
      [0.21, 0.61, 0.1],
      [0.28, 0.55, 0.42],
      [0.24, 0.3, 0.64],
    ].map((p) => new THREE.Vector3(...(p as P3)))
  );
  parts.push(C(new THREE.TubeGeometry(halo, FAR ? 10 : 28, 0.03, FAR ? 4 : 6)));
  parts.push(C(rod([0, 0.6, -0.03], [0, 0.28, -0.2], 0.032)));
  parts.push(C(loft([
    { z: 0.49, cy: 0.52, w: 0.18, h: 0.15, n: 2.8 },
    { z: 0.505, cy: 0.52, w: 0.18, h: 0.15, n: 2.8 },
  ])));
  parts.push(C(box([0.5, 0.03, 0.62], [0, 0.265, 0.28])));
  // Sidepod inlet mouths: dark, just ahead of the pod.
  const inlet = sectionAt(SIDEPOD, -0.62);
  parts.push(...pair(loft([
    { ...inlet, z: -0.635, w: inlet.w * 0.82, h: inlet.h * 0.7, cy: inlet.cy - 0.01 },
    { ...inlet, z: -0.62, w: inlet.w * 0.82, h: inlet.h * 0.7, cy: inlet.cy - 0.01 },
  ])).map((g) => colorize(g, CARBON_COLOR)));
  // Visor band.
  const visor = new THREE.SphereGeometry(0.163, FAR ? 8 : 14, 4, 1.5 * Math.PI - 0.95, 1.9, 1.08, 0.42);
  visor.translate(0, 0.42, 0.3);
  parts.push(colorize(normalize(visor), VISOR_COLOR));
  // Gearbox casing, tailpipe and the crash structure around the rain light.
  parts.push(C(loft([
    { z: 1.72, cy: 0.16, w: 0.3, h: 0.26, n: 3 },
    { z: 2.1, cy: 0.16, w: 0.2, h: 0.22, n: 3 },
  ])));
  {
    const pipe = new THREE.CylinderGeometry(0.045, 0.05, 0.16, FAR ? 5 : 8);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(0, 0.36, 2.0);
    parts.push(colorize(normalize(pipe), "#3a3d44"));
  }
  if (FAR) return parts;
  // Diffuser strakes, floor-edge fences and brake ducts.
  for (const x of [-0.3, 0, 0.3]) parts.push(C(sidePlate([[1.62, -0.36], [2.05, -0.36], [2.05, -0.22], [1.8, -0.3]], x - 0.008, x + 0.008)));
  for (const fx of [0.62, 0.7, 0.78]) {
    parts.push(...pair(sidePlate([[-1.0, -0.4], [-0.6, -0.4], [-0.62, -0.22], [-0.98, -0.28]], fx, fx + 0.012)).map((g) => colorize(g, CARBON_COLOR)));
  }
  for (const zc of [-WHEEL_Z, WHEEL_Z]) {
    parts.push(...pair(box([0.1, 0.2, 0.26], [0.6, -0.3, zc])).map((g) => colorize(g, CARBON_COLOR)));
  }
  // Suspension: wishbones and pushrods at each station.
  for (const zc of [-WHEEL_Z, WHEEL_Z]) {
    for (const side of [-1, 1]) {
      const s = (x: number): number => side * x;
      for (const [y0, y1] of [
        [0.1, 0.02],
        [-0.2, -0.18],
      ]) {
        parts.push(C(rod([s(0.3), y0, zc - 0.2], [s(0.7), y1, zc], 0.018)));
        parts.push(C(rod([s(0.3), y0, zc + 0.2], [s(0.7), y1, zc], 0.018)));
      }
      parts.push(C(rod([s(0.68), -0.16, zc], [s(0.3), 0.14, zc + 0.1], 0.018)));
    }
  }
  // Mirror stalks.
  for (const side of [-1, 1]) parts.push(C(rod([side * 0.36, 0.22, -0.1], [side * 0.56, 0.33, -0.15], 0.014)));
  return parts;
}

/** Where each wing assembly bends when damaged (car space). */
export const FRONT_WING_PIVOT: P3 = [0, -0.28, -2.0];
export const REAR_WING_PIVOT: P3 = [0, 0.4, 1.7];

export interface CarGeometry {
  paint: THREE.BufferGeometry;
  carbon: THREE.BufferGeometry;
  /** In the flap's own frame: leading edge at the origin, chord along +z. */
  flap: THREE.BufferGeometry;
  /** Front/rear wing assemblies (elements, endplates, pylons) in car space,
   * separate meshes so damage can droop or shed them. */
  frontWing: THREE.BufferGeometry;
  rearWing: THREE.BufferGeometry;
  /** Paint plus both wings in one mesh: cars that cannot be damaged (every rival) draw this and save two draw calls each. */
  paintWithWings: THREE.BufferGeometry;
}

export function buildCarGeometry(livery: string, accent: string): CarGeometry {
  const front: THREE.BufferGeometry[] = [];
  const rear: THREE.BufferGeometry[] = [];
  const paint = mergeGeometries(paintParts(livery, accent, front, rear), false);
  const carbon = mergeGeometries(carbonParts(front, rear), false);
  const frontWing = mergeGeometries(front, false);
  const rearWing = mergeGeometries(rear, false);
  const flap = colorize(normalize(wing(FLAP_CHORD, FLAP_SPAN, [0, 0], 0, 0.1, 0.06)), accent);
  if (!paint || !carbon || !frontWing || !rearWing) throw new Error("car geometry merge failed");
  const paintWithWings = mergeGeometries([paint, frontWing, rearWing], false);
  if (!paintWithWings) throw new Error("car geometry merge failed");
  for (const g of [paint, carbon, flap, frontWing, rearWing, paintWithWings]) g.computeBoundingSphere();
  return { paint, carbon, flap, frontWing, rearWing, paintWithWings };
}

/**
 * The whole car as ONE mesh at half the tessellation with the fine detail
 * left out and the wheels baked in (static, medium-compound stripes). Rivals
 * beyond ~70 m draw this instead of the seven-mesh car: one draw call and a
 * fraction of the triangles for something a few dozen pixels tall.
 */
export function buildFarCarGeometry(livery: string, accent: string): THREE.BufferGeometry {
  const ring = RING;
  const steps = FOIL_STEPS;
  RING = 10;
  FOIL_STEPS = 4;
  FAR = true;
  try {
    const front: THREE.BufferGeometry[] = [];
    const rear: THREE.BufferGeometry[] = [];
    const paint = paintParts(livery, accent, front, rear);
    const carbon = carbonParts(front, rear);
    const flap = colorize(normalize(wing(FLAP_CHORD, FLAP_SPAN, [0, 0], 0, 0.1, 0.06)), accent);
    flap.applyMatrix4(
      new THREE.Matrix4().compose(
        new THREE.Vector3(...FLAP_PIVOT),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(FLAP_CLOSED_INCLINE_RAD, 0, 0)),
        new THREE.Vector3(1, 1, 1)
      )
    );
    const wheels = CAR_WHEELS.map((w) => {
      const g = buildWheelGeometry(COMPOUND_STRIPE_COLOR.medium, w.isDriven, true);
      g.translate(...(w.position as P3));
      return g;
    });
    const merged = mergeGeometries([...paint, ...front, ...rear, ...carbon, flap, ...wheels].map(normalize), false);
    if (!merged) throw new Error("far car geometry merge failed");
    merged.computeBoundingSphere();
    return merged;
  } finally {
    RING = ring;
    FOIL_STEPS = steps;
    FAR = false;
  }
}

/**
 * One wheel, axis along x, centred on the physics wheel station: a rounded
 * tyre (lathe), a slotted wheel cover on both faces, a hub nut and a
 * compound-coloured sidewall stripe (red soft, yellow medium, white hard),
 * merged into a single vertex-coloured mesh. Rears are wider than fronts.
 */
export function buildWheelGeometry(
  stripe: string = COMPOUND_STRIPE_COLOR.medium,
  rear = false,
  simple = false
): THREE.BufferGeometry {
  const r = WHEEL_RADIUS;
  const hw = (rear ? REAR_TIRE_WIDTH : TIRE_WIDTH) / 2;
  const profile = [
    [0.21, -hw],
    [r - 0.035, -hw],
    [r - 0.008, -hw + 0.03],
    [r, -hw + 0.08],
    [r, hw - 0.08],
    [r - 0.008, hw - 0.03],
    [r - 0.035, hw],
    [0.21, hw],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const tire = new THREE.LatheGeometry(profile, simple ? 12 : 24);
  const rim = new THREE.CylinderGeometry(0.212, 0.212, 2 * hw - 0.02, simple ? 8 : 16, 1, true);
  const parts: THREE.BufferGeometry[] = [colorize(normalize(tire), TIRE_COLOR), colorize(normalize(rim), RIM_COLOR)];
  if (!simple) {
    // Wheel cover: alternating light and dark slots round a hub nut, set
    // slightly inside the sidewall so the rim reads as having depth.
    const slots = 10;
    for (const side of [-1, 1]) {
      for (let k = 0; k < slots; k++) {
        const d = new THREE.RingGeometry(0.06, 0.208, 1, 1, (k * 2 * Math.PI) / slots, (2 * Math.PI) / slots);
        d.rotateX(side * -Math.PI / 2);
        d.translate(0, side * (hw - 0.014), 0);
        parts.push(colorize(normalize(d), k % 2 ? "#3c4048" : "#181a1e"));
      }
      const nut = new THREE.CylinderGeometry(0.05, 0.05, 0.03, 8);
      nut.translate(0, side * (hw - 0.004), 0);
      parts.push(colorize(normalize(nut), "#9096a0"));
    }
    for (const side of [-1, 1]) {
      const t = new THREE.RingGeometry(0.262, 0.294, 24);
      t.rotateX(side * -Math.PI / 2);
      t.translate(0, side * (hw + 0.001), 0);
      parts.push(colorize(normalize(t), stripe));
    }
  } else {
    for (const side of [-1, 1]) {
      const t = new THREE.RingGeometry(0.262, 0.294, 12);
      t.rotateX(side * -Math.PI / 2);
      t.translate(0, side * (hw + 0.001), 0);
      parts.push(colorize(normalize(t), stripe));
    }
  }
  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error("wheel geometry merge failed");
  // Lathe/cylinder axes are y; the car's wheel axis is x.
  merged.rotateZ(Math.PI / 2);
  merged.computeBoundingSphere();
  return merged;
}
