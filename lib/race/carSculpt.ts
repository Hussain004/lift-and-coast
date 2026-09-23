// The F1 car as sculpted low-poly geometry (the previous generation was ~90
// axis-aligned boxes). Still procedural, still no assets: lofted
// superellipse sections for the nose/monocoque/engine cover, undercut
// coke-bottle sidepods and the airbox; cambered airfoil elements for both
// wings and the beam wing; profiled endplates, a shaped floor, a tube halo,
// wishbone suspension and rounded tyres.
//
// Draw-call budget is the point of the layout: colours are baked in as
// vertex colours, so a whole car is two body meshes (glossy paint, matte
// carbon), the DRS flap and four wheels - and a 20-car grid shares one set
// of geometry per livery. Frame and units match the RigidBody: +x right,
// +y up, -z forward, meters, wheel stations from CAR_WHEELS.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type P2 = [number, number];
type P3 = [number, number, number];

export const CARBON_COLOR = "#17181b";
export const VISOR_COLOR = "#0b0e12";
export const TIRE_COLOR = "#141414";
export const RIM_COLOR = "#2b2d31";
export const SIDEWALL_COLOR = "#f2c230";
export const HELMET_COLOR = "#f2f2f2";
export const LIGHT_COLOR = "#ff2a2a";

/** DRS flap: pivot (its leading edge) in the car frame, and chord/span. */
export const FLAP_PIVOT: P3 = [0, 0.64, 1.8];
export const FLAP_CHORD = 0.26;
export const FLAP_SPAN = 1.4;

export const WHEEL_RADIUS = 0.34;
export const TIRE_WIDTH = 0.3;

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

const RING = 20;

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
function loft(sections: Section[]): THREE.BufferGeometry {
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
  for (const s of [sections[0], sections[sections.length - 1]]) {
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
  const n = 7;
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

function paintParts(livery: string, accent: string): THREE.BufferGeometry[] {
  const L = (g: THREE.BufferGeometry) => colorize(normalize(g), livery);
  const A = (g: THREE.BufferGeometry) => colorize(normalize(g), accent);
  const parts: THREE.BufferGeometry[] = [];
  // Nose, monocoque and engine cover: one continuous loft.
  parts.push(
    L(
      loft([
        { z: -2.12, cy: -0.17, w: 0.12, h: 0.08, n: 2.4 },
        { z: -1.85, cy: -0.15, w: 0.2, h: 0.13, n: 2.6 },
        { z: -1.4, cy: -0.1, w: 0.3, h: 0.2, n: 2.8 },
        { z: -0.9, cy: -0.04, w: 0.44, h: 0.32, n: 3 },
        { z: -0.45, cy: -0.02, w: 0.62, h: 0.46, n: 3.2 },
        { z: 0.0, cy: -0.03, w: 0.72, h: 0.56, n: 3.6 },
        { z: 0.5, cy: -0.01, w: 0.74, h: 0.6, n: 3.6 },
        { z: 0.9, cy: 0.04, w: 0.6, h: 0.64, n: 3.2 },
        { z: 1.35, cy: 0.06, w: 0.42, h: 0.48, n: 3 },
        { z: 1.75, cy: 0.1, w: 0.26, h: 0.3, n: 2.8 },
        { z: 2.02, cy: 0.12, w: 0.14, h: 0.18, n: 2.6 },
      ])
    )
  );
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
  // Sidepods: undercut inlets tapering into the coke bottle.
  const sidepod = loft([
    { z: -0.56, cx: 0.56, cy: -0.07, w: 0.34, h: 0.3, n: 3, undercut: 0.35 },
    { z: -0.35, cx: 0.58, cy: -0.08, w: 0.42, h: 0.38, n: 3.4, undercut: 0.35 },
    { z: 0.2, cx: 0.57, cy: -0.1, w: 0.44, h: 0.38, n: 3.4, undercut: 0.4 },
    { z: 0.7, cx: 0.5, cy: -0.14, w: 0.34, h: 0.3, n: 3, undercut: 0.3 },
    { z: 1.05, cx: 0.38, cy: -0.2, w: 0.2, h: 0.18, n: 2.8 },
    { z: 1.25, cx: 0.3, cy: -0.24, w: 0.1, h: 0.1, n: 2.6 },
  ]);
  parts.push(...pair(sidepod).map((g) => colorize(g, livery)));
  // Accent: nose tip band, sidepod shoulder stripes, engine cover stripe.
  parts.push(A(loft([
    { z: -2.14, cy: -0.17, w: 0.126, h: 0.086, n: 2.4 },
    { z: -1.9, cy: -0.152, w: 0.19, h: 0.126, n: 2.6 },
  ])));
  parts.push(...pair(box([0.3, 0.03, 0.7], [0.56, 0.1, 0.1])).map((g) => colorize(g, accent)));
  parts.push(A(box([0.08, 0.02, 0.9], [0, 0.34, 1.0])));
  // Front wing endplates and rear wing endplates.
  parts.push(
    ...pair(
      sidePlate(
        [
          [-2.3, -0.37],
          [-1.72, -0.37],
          [-1.72, -0.13],
          [-1.98, -0.06],
          [-2.3, -0.2],
        ],
        0.93,
        0.965
      )
    ).map((g) => colorize(g, livery))
  );
  parts.push(
    ...pair(
      sidePlate(
        [
          [1.5, 0.28],
          [2.06, 0.26],
          [2.12, 0.5],
          [2.1, 0.86],
          [1.9, 0.9],
          [1.6, 0.88],
          [1.48, 0.7],
        ],
        0.72,
        0.755
      )
    ).map((g) => colorize(g, livery))
  );
  // Mirrors.
  parts.push(...pair(box([0.16, 0.07, 0.09], [0.6, 0.34, -0.15])).map((g) => colorize(g, livery)));
  // Helmet and the rain light ride the paint mesh (glossy).
  const helmet = new THREE.SphereGeometry(0.16, 16, 12);
  helmet.translate(0, 0.42, 0.3);
  parts.push(colorize(normalize(helmet), HELMET_COLOR));
  parts.push(colorize(normalize(box([0.12, 0.12, 0.05], [0, 0.26, 2.04])), LIGHT_COLOR));
  return parts;
}

function carbonParts(): THREE.BufferGeometry[] {
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
  // Front wing: three elements; rear wing main plane; beam wing.
  parts.push(C(wing(0.42, 1.86, [-2.28, -0.33], 0.05)));
  parts.push(C(wing(0.26, 1.8, [-2.0, -0.28], 0.28)));
  parts.push(C(wing(0.18, 1.7, [-1.86, -0.21], 0.5)));
  parts.push(C(wing(0.36, 1.44, [1.52, 0.52], 0.16)));
  parts.push(C(wing(0.24, 1.2, [1.72, 0.14], 0.12)));
  // Swan-neck pylons, front wing pylons, halo, airbox intake, cockpit rim.
  parts.push(...pair(sidePlate([[1.62, 0.1], [1.78, 0.1], [1.74, 0.56], [1.64, 0.56]], 0.1, 0.13)).map((g) => colorize(g, CARBON_COLOR)));
  parts.push(...pair(sidePlate([[-2.1, -0.32], [-1.9, -0.32], [-1.9, -0.18], [-2.02, -0.16]], 0.1, 0.13)).map((g) => colorize(g, CARBON_COLOR)));
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
  parts.push(C(new THREE.TubeGeometry(halo, 28, 0.028, 6)));
  parts.push(C(rod([0, 0.6, -0.03], [0, 0.28, -0.2], 0.03)));
  parts.push(C(loft([
    { z: 0.49, cy: 0.52, w: 0.18, h: 0.15, n: 2.8 },
    { z: 0.505, cy: 0.52, w: 0.18, h: 0.15, n: 2.8 },
  ])));
  parts.push(C(box([0.5, 0.03, 0.62], [0, 0.265, 0.28])));
  // Sidepod inlet mouths.
  parts.push(...pair(loft([
    { z: -0.575, cx: 0.56, cy: -0.07, w: 0.28, h: 0.22, n: 3, undercut: 0.35 },
    { z: -0.55, cx: 0.56, cy: -0.07, w: 0.28, h: 0.22, n: 3, undercut: 0.35 },
  ])).map((g) => colorize(g, CARBON_COLOR)));
  // Visor band.
  const visor = new THREE.SphereGeometry(0.163, 14, 4, 1.5 * Math.PI - 0.95, 1.9, 1.08, 0.42);
  visor.translate(0, 0.42, 0.3);
  parts.push(colorize(normalize(visor), VISOR_COLOR));
  // Suspension: wishbones and pushrods at each station.
  for (const zc of [-WHEEL_Z, WHEEL_Z]) {
    for (const side of [-1, 1]) {
      const s = (x: number): number => side * x;
      for (const [y0, y1] of [
        [0.1, 0.02],
        [-0.2, -0.18],
      ]) {
        parts.push(C(rod([s(0.3), y0, zc - 0.2], [s(0.7), y1, zc], 0.016)));
        parts.push(C(rod([s(0.3), y0, zc + 0.2], [s(0.7), y1, zc], 0.016)));
      }
      parts.push(C(rod([s(0.68), -0.16, zc], [s(0.3), 0.14, zc + 0.1], 0.016)));
    }
  }
  // Mirror stalks and the crash structure around the rain light.
  for (const side of [-1, 1]) parts.push(C(rod([side * 0.36, 0.22, -0.1], [side * 0.56, 0.33, -0.15], 0.012)));
  parts.push(C(box([0.22, 0.2, 0.3], [0, 0.2, 1.9])));
  return parts;
}

export interface CarGeometry {
  paint: THREE.BufferGeometry;
  carbon: THREE.BufferGeometry;
  /** In the flap's own frame: leading edge at the origin, chord along +z. */
  flap: THREE.BufferGeometry;
}

export function buildCarGeometry(livery: string, accent: string): CarGeometry {
  const paint = mergeGeometries(paintParts(livery, accent), false);
  const carbon = mergeGeometries(carbonParts(), false);
  const flap = colorize(normalize(wing(FLAP_CHORD, FLAP_SPAN, [0, 0], 0, 0.1, 0.06)), accent);
  if (!paint || !carbon) throw new Error("car geometry merge failed");
  for (const g of [paint, carbon, flap]) g.computeBoundingSphere();
  return { paint, carbon, flap };
}

/**
 * One wheel, axis along x, centred on the physics wheel station: a rounded
 * tyre (lathe), rim, hub and a compound-coloured sidewall stripe, merged
 * into a single vertex-coloured mesh.
 */
export function buildWheelGeometry(): THREE.BufferGeometry {
  const r = WHEEL_RADIUS;
  const hw = TIRE_WIDTH / 2;
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
  const tire = new THREE.LatheGeometry(profile, 24);
  const rim = new THREE.CylinderGeometry(0.212, 0.212, TIRE_WIDTH - 0.02, 16);
  const hub = new THREE.CylinderGeometry(0.07, 0.07, TIRE_WIDTH + 0.01, 8);
  const stripes = [-1, 1].map((side) => {
    const t = new THREE.TorusGeometry(0.28, 0.011, 4, 24);
    t.rotateX(Math.PI / 2);
    t.translate(0, side * (hw + 0.001), 0);
    return t;
  });
  const merged = mergeGeometries(
    [
      colorize(normalize(tire), TIRE_COLOR),
      colorize(normalize(rim), RIM_COLOR),
      colorize(normalize(hub), CARBON_COLOR),
      ...stripes.map((s) => colorize(normalize(s), SIDEWALL_COLOR)),
    ],
    false
  );
  if (!merged) throw new Error("wheel geometry merge failed");
  // Lathe/cylinder axes are y; the car's wheel axis is x.
  merged.rotateZ(Math.PI / 2);
  merged.computeBoundingSphere();
  return merged;
}
